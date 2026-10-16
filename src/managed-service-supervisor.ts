import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsCommandRunner, type JobExitEvidence } from "./execution-runner.js";
import { ExecutionStateStore, type ExecutionOwnerIdentity } from "./execution-state-store.js";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import {
  ManagedServiceReservations, type ServiceReservationInput, type ServiceReservationRow,
} from "./managed-service-reservations.js";
import { nativeRecoveryProbe } from "./windows-recovery-observer.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";

const pause = (ms: number) => delay(ms);
type ServiceInput = ServiceReservationInput & {
  /** The process must implement GET /healthz and respond with
   * X-Taskquay-Health-Token equal to TASKQUAY_SERVICE_HEALTH_TOKEN.
   * Restrict to loopback: this proof is for local service identity, not
   * a public authentication boundary.
   */
  command: string;
  healthTimeoutMs?: number;
};

async function portAvailable(port: number): Promise<boolean> {
  const socket = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        socket.off("error", reject); resolve();
      });
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

async function httpHealth(port: number, secret: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = request({
      hostname: "127.0.0.1", port, path: "/healthz", method: "GET",
      agent: false, timeout: 750,
    }, (response) => {
      const verified = response.statusCode === 200 &&
        response.headers["x-taskquay-health-token"] === secret;
      response.resume();
      response.once("end", () => resolve(verified));
      response.once("error", () => resolve(false));
    });
    req.once("timeout", () => req.destroy(new Error("SERVICE_HEALTH_TIMEOUT")));
    req.once("error", () => resolve(false));
    req.end();
  });
}

/** True only when the exact original Windows Job no longer exists and
 * its recorded bootstrap process has exited. No timeout-based unlock.
 */
async function waitNativeExited(executionId: string, coordinator: ExecutionCoordinator,
  proof: JobExitEvidence): Promise<boolean> {
  const row = new ExecutionStateStore(coordinator.sharedDatabaseHandle.sqlite).get(executionId);
  if (!row || row.job_identity !== proof.jobIdentity ||
      row.runner_pid !== proof.runnerPid ||
      typeof row.runner_created_at !== "string") return false;
  for (let i = 0; i < 60; i++) {
    if (nativeRecoveryProbe.job(proof.jobIdentity) === "absent" &&
        nativeRecoveryProbe.process(proof.runnerPid, row.runner_created_at) === "absent_or_reused") {
      return true;
    }
    await pause(50);
  }
  return false;
}

/** Only an opted-in supervisor process owns these Job handles. It does not
 * adopt old services, create Windows services, change startup, or watch a
 * user's existing listening ports. Caller supplies a registered native Owner.
 */
export class ManagedServiceSupervisor {
  private readonly reservations: ManagedServiceReservations;
  constructor(private readonly coordinator: ExecutionCoordinator) {
    this.reservations = new ManagedServiceReservations(coordinator);
  }

  async start(input: ServiceInput): Promise<ManagedServiceHandle> {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("SERVICE_RUNNER_UNSUPPORTED_OS");
    }
    if (input.bindHost !== "127.0.0.1") throw new Error("SERVICE_RUNNER_LOOPBACK_ONLY");
    if (!input.command.trim() || input.command.length > 8192) {
      throw new Error("SERVICE_RUNNER_COMMAND_INVALID");
    }
    if (input.owner.pid !== process.pid ||
        input.owner.bootId !== windowsBootIdentity() ||
        input.owner.processCreatedAt !== windowsProcessCreatedAt(process.pid)) {
      throw new Error("SERVICE_OWNER_NATIVE_IDENTITY_MISMATCH");
    }
    const timeout = input.healthTimeoutMs ?? 4_000;
    if (!Number.isSafeInteger(timeout) || timeout < 500 || timeout > 30_000) {
      throw new Error("SERVICE_HEALTH_BUDGET_INVALID");
    }
    if (!(await portAvailable(input.port))) throw new Error("SERVICE_PORT_ALREADY_BOUND");
    const reservation = this.reservations.reserve(input);
    const token = randomBytes(24).toString("hex");
    let runner: WindowsCommandRunner | undefined;
    try {
      runner = await WindowsCommandRunner.start({
        executionId: reservation.execution_id,
        generation: 1,
        // The service never uses the Agent's mutable checkout as its state dir.
        cwd: reservation.state_root,
        environment: {
          Path: process.env.Path ?? process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          WINDIR: process.env.WINDIR ?? "",
          TEMP: process.env.TEMP ?? "",
          TMP: process.env.TMP ?? "",
          TASKQUAY_SERVICE_PORT: String(input.port),
          TASKQUAY_SERVICE_BIND_HOST: input.bindHost,
          TASKQUAY_SERVICE_HEALTH_TOKEN: token,
          TASKQUAY_SERVICE_STATE_ROOT: reservation.state_root,
        },
        command: input.command,
        persistArmed: (proof) => {
          this.coordinator.withManagedState((sqlite) => {
            const store = new ExecutionStateStore(sqlite);
            const current = store.get(reservation.execution_id)!;
            const armed = store.arm({
              executionId: current.id, expectedGeneration: current.generation,
              expectedVersion: current.state_version, pid: proof.runnerPid,
              createdAt: proof.runnerCreatedAt, bootId: input.owner.bootId,
              jobIdentity: proof.jobIdentity, evidence: JSON.stringify({
                kind: "os_job_membership", count: proof.memberCount,
                proofAt: proof.armedAt,
              }),
            });
            store.transition({
              executionId: armed.id, expectedGeneration: armed.generation,
              expectedVersion: armed.state_version, phase: "running",
            });
          });
        },
      });
      const endAt = Date.now() + timeout;
      let healthy = false;
      while (Date.now() < endAt) {
        if (await httpHealth(input.port, token)) { healthy = true; break; }
        if (runner.activeProcesses === 0) break;
        await pause(75);
      }
      if (!healthy) throw new Error("SERVICE_HEALTH_NOT_CONFIRMED");
      this.reservations.confirmRunning(reservation.service_id);
      return new ManagedServiceHandle(this.coordinator, this.reservations,
        reservation, runner, token);
    } catch (error) {
      if (runner) {
        // An armed-but-never-healthy service is still a managed OS process.
        // Cancel precisely its own Job and release ONLY on native exit proof.
        try {
          const proof = await runner.cancel(0);
          if (await waitNativeExited(reservation.execution_id, this.coordinator, proof)) {
            const store = new ExecutionStateStore(this.coordinator.sharedDatabaseHandle.sqlite);
            const current = store.get(reservation.execution_id)!;
            store.transition({
              executionId: current.id, expectedGeneration: current.generation,
              expectedVersion: current.state_version, phase: "terminal",
              outcome: "failed", resourceState: "released",
              exitEvidence: { kind: "job_empty_verified",
                verifiedAt: proof.verifiedAt, verifier: "WindowsCommandRunner",
                detail: JSON.stringify(proof) },
            });
            this.reservations.finalizeExited(reservation.service_id);
          }
        } catch { /* fail-closed: retain reservation and native claim evidence */ }
      }
      throw error;
    }
  }
}

export class ManagedServiceHandle {
  private stopping?: Promise<void>;
  constructor(private readonly coordinator: ExecutionCoordinator,
    private readonly reservations: ManagedServiceReservations,
    readonly reservation: ServiceReservationRow,
    private readonly runner: WindowsCommandRunner,
    private readonly healthToken: string) {}

  get serviceId(): string { return this.reservation.service_id; }
  get jobIdentity(): string { return this.runner.jobIdentity; }
  async checkHealth(): Promise<boolean> {
    if (this.stopping || this.reservations.inspect(this.serviceId)?.state !== "running") return false;
    if (nativeRecoveryProbe.job(this.runner.jobIdentity) !== "exists_active") return false;
    return httpHealth(this.reservation.port, this.healthToken);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopWithEvidence().catch((error: unknown) => {
      // An uncertain native observation may become verifiable later.
      // Retain reservation; let a subsequent explicit stop retry verify.
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }
  private async stopWithEvidence(): Promise<void> {
    this.coordinator.withManagedState((sqlite) => {
      const row = this.reservations.inspect(this.serviceId);
      if (!row || !["running", "stopping"].includes(row.state)) {
        throw new Error("SERVICE_NOT_ACTIVE");
      }
      const store = new ExecutionStateStore(sqlite);
      const current = store.get(row.execution_id)!;
      if (row.state === "running") {
        store.transition({ executionId: current.id, expectedGeneration: current.generation,
          expectedVersion: current.state_version, phase: "stopping", stopReason: "supervisor_stop" });
        const changed = sqlite.prepare(`update managed_service_reservations
          set state='stopping',updated_at=? where service_id=? and state='running'`)
          .run(new Date().toISOString(), row.service_id);
        if (changed.changes !== 1) throw new Error("SERVICE_STOP_CAS_FAILED");
      } else if (current.phase !== "stopping" && current.phase !== "terminal") {
        throw new Error("SERVICE_STOP_RECONCILIATION_REQUIRED");
      }
    });
    const proof = await this.runner.cancel(0);
    if (!(await waitNativeExited(this.reservation.execution_id, this.coordinator, proof))) {
      throw new Error("SERVICE_STOP_NATIVE_EXIT_UNVERIFIED");
    }
    const store = new ExecutionStateStore(this.coordinator.sharedDatabaseHandle.sqlite);
    const current = store.get(this.reservation.execution_id)!;
    if (current.phase !== "terminal") {
      store.transition({
        executionId: current.id, expectedGeneration: current.generation,
        expectedVersion: current.state_version, phase: "terminal", outcome: "cancelled",
        resourceState: "released",
        exitEvidence: { kind: "job_empty_verified",
          verifiedAt: proof.verifiedAt, verifier: "WindowsCommandRunner", detail: JSON.stringify(proof) },
      });
    } else if (current.resource_state !== "released" || !current.exit_evidence) {
      throw new Error("SERVICE_TERMINAL_PROOF_NOT_COMMITTED");
    }
    this.reservations.finalizeExited(this.serviceId);
  }
}
