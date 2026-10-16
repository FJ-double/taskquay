/**
 * Explicit TEST-ONLY standalone service host. A separate Node OS process
 * owns its own Coordinator/Owner heartbeat, service Job and health audit.
 * It never connects to, launches, or modifies production Taskquay.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { ExecutionCoordinator } from "./execution-coordinator.js";
import { ManagedOwnerLease } from "./managed-owner-lease.js";
import { ManagedServiceSupervisor } from "./managed-service-supervisor.js";
import { ManagedServiceHealthMonitor, readServiceHealthAlert } from "./managed-service-health-monitor.js";
import { windowsBootIdentity } from "./windows-boot-identity.js";
import { windowsProcessCreatedAt } from "./windows-job-object.js";
import { acquireServiceOwnerSingleton } from "./managed-service-owner-singleton.js";
import { ManagedServiceLocalControl } from "./managed-service-local-control.js";
import { readIsolatedServiceHostConfig } from "./managed-service-launch-config.js";

if (process.platform !== "win32" || process.env.TASKQUAY_SERVICE_HOST_FIXTURE !== "1" ||
    !process.argv[2]) process.exit(72);
const config = readIsolatedServiceHostConfig(process.argv[2]);
// Same-state-directory second supervisor must not launch another service.
const releaseSingleton = acquireServiceOwnerSingleton(config.stateDir);
const coordinator = new ExecutionCoordinator(config.stateDir);
const owner = {
  id: coordinator.managedOwnerId, kind: "agentd" as const,
  pid: process.pid, processCreatedAt: windowsProcessCreatedAt(process.pid),
  bootId: windowsBootIdentity(), generation: randomUUID(),
};
coordinator.registerManagedOwner(owner);
const lease = new ManagedOwnerLease(coordinator.sharedDatabaseHandle.sqlite, owner, 150, 900);
lease.start();
const supervisor = new ManagedServiceSupervisor(coordinator);
const emit = (event: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ event, pid: process.pid, ...extra }) + "\n");
let stopping = false;
let monitor: ManagedServiceHealthMonitor | undefined;
let handle: Awaited<ReturnType<ManagedServiceSupervisor["start"]>> | undefined;
let control: ManagedServiceLocalControl | undefined;
// Explicit independent lifetime: a disconnected client pipe MUST NOT cause
// Node to exit and implicitly close every service Job handle it owns.
const keepAlive = setInterval(() => {}, 2_000);
const cleanup = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await control?.close();
    await monitor?.stop();
    await handle?.stop();
    emit("STOPPED", { serviceId: handle?.serviceId });
  } catch (error) {
    emit("STOP_FAILED", { error: String(error) });
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
    lease.stop();
    coordinator.close();
    releaseSingleton();
    process.stdin.pause();
    process.exitCode ??= 0;
  }
};
process.on("SIGINT", () => { void cleanup(); });
process.on("SIGTERM", () => { void cleanup(); });
try {
  handle = await supervisor.start({
    workspaceId: "independent-service-owner-fixture",
    workspaceRoot: config.workspaceRoot, stateRoot: config.stateRoot,
    serviceKey: config.serviceKey, port: config.port, command: config.command,
    bindHost: "127.0.0.1", owner, healthTimeoutMs: 5_000,
  });
  monitor = new ManagedServiceHealthMonitor(coordinator, handle, 125);
  await monitor.sample();
  monitor.start();
  control = new ManagedServiceLocalControl({
    status: () => {
      const row=coordinator.sharedDatabaseHandle.sqlite.prepare(
        "select state from managed_service_reservations where service_id=?",
      ).get(handle?.serviceId) as {state:string}|undefined;
      const alert=handle?readServiceHealthAlert(coordinator,handle.serviceId):undefined;
      return {ok:true,status:row?.state ?? "unknown",serviceId:handle?.serviceId,
        alert:alert?.active ?? false};
    },
    health: async () => {
      const sampled=await monitor?.sample();
      return {ok:true,health:sampled?.outcome ?? "unavailable",
        serviceId:handle?.serviceId};
    },
    stop: cleanup,
  });
  // TEST harness only: stdout is the private spawn pipe controlled by
  // the parent. Never print control capabilities to a production log.
  const endpoint = await control.start();
  emit("READY", { serviceId: handle.serviceId, jobIdentity: handle.jobIdentity,
    ownerId: owner.id, ownerGeneration: owner.generation, ...endpoint });
  const io = createInterface({ input: process.stdin });
  io.on("line", (line) => {
    if (line.trim() === "STOP") void cleanup();
    else if (line.trim() === "HEALTH") void (async () => {
      if (!monitor) return;
      try { const event = await monitor.sample(); emit("HEALTH", { outcome: event?.outcome }); }
      catch { emit("HEALTH_ERROR"); }
    })();
  });
  io.on("close", () => {
    // The service Job belongs to this independent OS process. Closing a
    // client's pipe is never authority to free or terminate its Job.
  });
} catch (error) {
  emit("START_FAILED", { error: String(error) });
  clearInterval(keepAlive);
  lease.stop(); coordinator.close();
  releaseSingleton();
  process.exitCode = 1;
}
