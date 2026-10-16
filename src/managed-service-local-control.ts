import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WindowsJobObject } from "./windows-job-object.js";

export type ServiceControlResponse = {
  ok: boolean; status?: string; serviceId?: string;
  alert?: boolean;
  health?: "healthy" | "unhealthy" | "probe_error" | "unavailable";
  error?: string;
};
type Actions = {
  status(): ServiceControlResponse;
  health(): Promise<ServiceControlResponse>;
  stop(): Promise<void>;
};

/**
 * TEST-ONLY. A separate PowerShell 7 broker creates the native Windows pipe
 * with a restricted DACL in CreateNamedPipe. Node does not create a listener:
 * the default publicly readable Node pipe DACL is never used.
 *
 * The broker is placed inside a kill-on-close Job *before* it is instructed
 * to create a pipe. Authentication is still checked here using the private
 * 256-bit capability; never print it to stderr, a command line or the DB.
 */
export class ManagedServiceLocalControl {
  private readonly token = randomBytes(32);
  private readonly pipeName = "taskquay-experimental-service-" +
    randomBytes(16).toString("hex");
  private readonly pipePath = "\\\\.\\pipe\\" + this.pipeName;
  private broker?: ChildProcessWithoutNullStreams;
  private brokerJob?: WindowsJobObject;
  private closing = false;
  private stdout = "";
  private readonly stopAcks = new Set<number>();
  constructor(private readonly actions: Actions) {}

  async start(): Promise<{ pipePath: string; token: string }> {
    if (process.platform !== "win32") throw new Error("SERVICE_CONTROL_WINDOWS_ONLY");
    if (process.env.TASKQUAY_SERVICE_HOST_FIXTURE !== "1") {
      throw new Error("SERVICE_CONTROL_TEST_ONLY");
    }
    if (this.broker || this.closing) throw new Error("SERVICE_CONTROL_ALREADY_STARTED");
    const script = fileURLToPath(new URL("../scripts/windows-service-control-broker.ps1", import.meta.url));
    const job = new WindowsJobObject();
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script,
        "-PipeName", this.pipeName], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(?:PATH|SystemRoot|windir|TEMP|TMP|USERPROFILE|PSModulePath)$/i.test(key))),
      });
      if (!child.pid) throw new Error("SERVICE_CONTROL_BROKER_SPAWN_FAILED");
      job.assignVerified(child.pid);
    } catch (error) {
      child?.kill();
      job.close();
      throw error;
    }
    this.broker = child;
    this.brokerJob = job;
    if (process.env.TASKQUAY_CONTROL_BROKER_TEST_DIAGNOSTICS === "1") {
      child.once("exit", (code, signal) => {
        process.stderr.write(`TEST_BROKER_EXIT code=${code} signal=${signal}\n`);
      });
      child.stderr.on("data", (bytes: Buffer) =>
        process.stderr.write(bytes.toString("utf8").slice(0, 1024)));
    }
    child.on("error", () => { /* lost control channel never frees service Job */ });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("SERVICE_CONTROL_BROKER_START_TIMEOUT")), 10_000);
        const onError = () => reject(new Error("SERVICE_CONTROL_BROKER_FAILED"));
        const onExit = () => reject(new Error("SERVICE_CONTROL_BROKER_EXITED"));
        const settled = (result?: Error) => {
          clearTimeout(timeout);
          child.off("error", onError);
          child.off("exit", onExit);
          result ? reject(result) : resolve();
        };
        child.once("error", onError);
        child.once("exit", onExit);
        child.stdout.on("data", (part: Buffer) => {
          this.stdout += part.toString("utf8");
          if (this.stdout.length > 8192) {
            this.brokerJob?.close(); // fail closed; never trust unbounded broker data
            settled(new Error("SERVICE_CONTROL_BROKER_OUTPUT_TOO_LARGE"));
            return;
          }
          for (;;) {
            const i = this.stdout.indexOf("\n");
            if (i < 0) break;
            const line = this.stdout.slice(0, i).trim();
            this.stdout = this.stdout.slice(i + 1);
            let msg: Record<string, unknown>;
            try { msg = JSON.parse(line) as Record<string, unknown>; }
            catch { settled(new Error("SERVICE_CONTROL_BROKER_PROTOCOL")); return; }
            if (msg.event === "READY") { settled(); continue; }
            void this.handleBrokerMessage(msg);
          }
        });
        child.stdin.write("GO\n");
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    return {pipePath:this.pipePath,token:this.token.toString("hex")};
  }

  private async handleBrokerMessage(msg: Record<string, unknown>): Promise<void> {
    if (!this.broker || this.closing) return;
    if (msg.event === "ACK" && Number.isSafeInteger(msg.id)) {
      const id = msg.id as number;
      if (this.stopAcks.delete(id)) {
        void this.actions.stop().catch(() => { /* preserve native Job evidence */ });
      }
      return;
    }
    if (msg.event !== "REQUEST" || !Number.isSafeInteger(msg.id) ||
        typeof msg.raw !== "string" || msg.raw.length > 4096) {
      return;
    }
    const raw = Buffer.from(msg.raw, "base64").toString("utf8");
    const id = msg.id as number;
    const reply = await this.handleRequest(raw);
    if (this.closing || !this.broker) return;
    if (reply.stop) this.stopAcks.add(id);
    try {
      this.broker.stdin.write(JSON.stringify({event:"RESPONSE",id,
        body:JSON.stringify(reply.body)}) + "\n");
    } catch {
      this.stopAcks.delete(id);
    }
  }

  private async handleRequest(raw: string): Promise<{body:ServiceControlResponse;stop:boolean}> {
    const error = (message:string) => ({body:{ok:false,error:message},stop:false});
    if (Buffer.byteLength(raw,"utf8") > 2048) return error("CONTROL_MESSAGE_TOO_LARGE");
    let request: unknown;
    try { request = JSON.parse(raw); } catch { return error("CONTROL_INVALID_JSON"); }
    if (this.closing || !request || typeof request !== "object" || Array.isArray(request)) {
      return error("CONTROL_UNAVAILABLE");
    }
    const msg = request as Record<string, unknown>;
    if (msg.protocol !== 1 || typeof msg.token !== "string" ||
        !/^[a-f0-9]{64}$/i.test(msg.token) ||
        !timingSafeEqual(Buffer.from(msg.token,"hex"), this.token)) {
      return error("CONTROL_UNAUTHORIZED");
    }
    if (msg.command === "STATUS") {
      try { return {body:this.actions.status(),stop:false}; }
      catch { return error("CONTROL_STATUS_UNAVAILABLE"); }
    }
    if (msg.command === "HEALTH") {
      try { return {body:await this.actions.health(),stop:false}; }
      catch { return error("CONTROL_HEALTH_UNAVAILABLE"); }
    }
    if (msg.command === "STOP") return {body:{ok:true,status:"stop_requested"},stop:true};
    return error("CONTROL_UNKNOWN_COMMAND");
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const job = this.brokerJob;
    this.brokerJob = undefined;
    this.broker = undefined;
    this.stopAcks.clear();
    // Closing our private Job's last handle kills only the broker, not
    // the independent service Job or other users' Windows processes.
    job?.close();
    this.token.fill(0);
  }
}
