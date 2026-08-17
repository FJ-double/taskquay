import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import {
  decodeAgentRecord,
  decodeAgentRecordList,
  decodeDaemonLogs,
  decodeDaemonStatus,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonRequest,
  LocalAgentDaemonProtocolError,
  type LocalAgentDaemonRequest,
  type LocalAgentDaemonResponse,
  type LocalAgentDaemonStatus,
} from "./local-agent-daemon-protocol.js";
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ensureLocalAgentDaemonSecret,
  localAgentDaemonPaths,
  readLocalAgentDaemonSecret,
  type LocalAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import type { RunOverrides, StartLocalAgentInput } from "./local-agent-manager.js";
import type { LocalAgentListScope, LocalAgentRecord, LocalAgentWorkspaceScope } from "./local-agent-store.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 40;

export interface LocalAgentClientOptions {
  stateDir: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  spawnDaemon?: () => void;
  endpoint?: string;
}

export class LocalAgentDaemonClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAgentDaemonClientError";
  }
}

export class LocalAgentClient {
  private readonly stateDir: string;
  private readonly paths: LocalAgentDaemonPaths;
  private readonly endpoint: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly spawnDaemon: () => void;
  private startupPromise?: Promise<LocalAgentDaemonStatus>;

  constructor(options: LocalAgentClientOptions) {
    this.stateDir = options.stateDir;
    this.paths = localAgentDaemonPaths(options.stateDir);
    this.endpoint = options.endpoint ?? this.paths.endpoint;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnDaemon = options.spawnDaemon ?? (() => spawnLocalAgentDaemon(options.stateDir));
  }

  async run(input: StartLocalAgentInput): Promise<LocalAgentRecord> {
    return this.start(input);
  }

  async start(input: StartLocalAgentInput): Promise<LocalAgentRecord> {
    const result = await this.request("agent.start", input);
    return decodeAgentRecord(result);
  }

  async continue(agentId: string, prompt: string, overrides: RunOverrides = {}, scope: LocalAgentWorkspaceScope): Promise<LocalAgentRecord> {
    const result = await this.request("agent.continue", {
      id: agentId,
      prompt,
      scope,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    });
    return decodeAgentRecord(result);
  }

  async get(agentId: string, scope: LocalAgentWorkspaceScope): Promise<LocalAgentRecord | undefined> {
    const result = await this.request("agent.get", { id: agentId, scope });
    return result === null ? undefined : decodeAgentRecord(result);
  }

  async list(scope: LocalAgentListScope): Promise<LocalAgentRecord[]> {
    return decodeAgentRecordList(await this.request("agent.list", scope));
  }

  async status(): Promise<LocalAgentDaemonStatus> {
    return decodeDaemonStatus(await this.requestExisting("daemon.status", {}));
  }

  async stop(): Promise<LocalAgentDaemonStatus> {
    return decodeDaemonStatus(await this.requestExisting("daemon.stop", {}));
  }

  async logs(lines = 200): Promise<string> {
    return decodeDaemonLogs(await this.requestExisting("daemon.logs", { lines }));
  }

  async ensureReady(): Promise<LocalAgentDaemonStatus> {
    if (this.startupPromise) return this.startupPromise;
    this.startupPromise = this.ensureReadyInternal().finally(() => {
      this.startupPromise = undefined;
    });
    return this.startupPromise;
  }

  private async ensureReadyInternal(): Promise<LocalAgentDaemonStatus> {
    const existing = await this.tryHello();
    if (existing) return existing;

    this.spawnDaemon();
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      await delay(RETRY_DELAY_MS);
      try {
        const ready = await this.tryHello();
        if (ready) return ready;
      } catch (error) {
        lastError = error;
        if (error instanceof LocalAgentDaemonClientError && error.code === "PROTOCOL_MISMATCH") throw error;
      }
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new LocalAgentDaemonClientError(
      "DAEMON_START_FAILED",
      `Unable to start the local agent daemon in ${this.stateDir}${suffix}`,
    );
  }

  private async tryHello(): Promise<LocalAgentDaemonStatus | undefined> {
    try {
      const response = await sendRequest(this.endpoint, {
        requestId: randomUUID(),
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        authToken: ensureLocalAgentDaemonSecret(this.paths),
        method: "hello",
        params: {},
      }, this.requestTimeoutMs);
      if (!response.ok) {
        if (response.error.code === "PROTOCOL_MISMATCH") {
          throw new LocalAgentDaemonClientError(response.error.code, response.error.message);
        }
        return undefined;
      }
      const status = decodeDaemonStatus(response.result);
      return status.state === "ready" ? status : undefined;
    } catch (error) {
      if (error instanceof LocalAgentDaemonClientError && error.code === "PROTOCOL_MISMATCH") throw error;
      return undefined;
    }
  }

  private async request<M extends LocalAgentDaemonRequest["method"]>(
    method: M,
    params: Extract<LocalAgentDaemonRequest, { method: M }>['params'],
  ): Promise<unknown> {
    await this.ensureReady();
    const response = await sendRequest(this.endpoint, {
      requestId: randomUUID(),
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      authToken: ensureLocalAgentDaemonSecret(this.paths),
      method,
      params,
    } as LocalAgentDaemonRequest, this.requestTimeoutMs);
    if (!response.ok) {
      throw new LocalAgentDaemonClientError(response.error.code, response.error.message);
    }
    return response.result;
  }

  private async requestExisting<M extends LocalAgentDaemonRequest["method"]>(
    method: M,
    params: Extract<LocalAgentDaemonRequest, { method: M }>['params'],
  ): Promise<unknown> {
    const authToken = readLocalAgentDaemonSecret(this.paths);
    if (!authToken) {
      throw new LocalAgentDaemonClientError("DAEMON_UNAVAILABLE", "Local agent daemon is not running.");
    }
    try {
      const response = await sendRequest(this.endpoint, {
        requestId: randomUUID(),
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        authToken,
        method,
        params,
      } as LocalAgentDaemonRequest, this.requestTimeoutMs);
      if (!response.ok) {
        throw new LocalAgentDaemonClientError(response.error.code, response.error.message);
      }
      return response.result;
    } catch (error) {
      if (error instanceof LocalAgentDaemonClientError && error.code === "PROTOCOL_MISMATCH") throw error;
      if (error instanceof LocalAgentDaemonClientError && error.code === "DAEMON_UNAVAILABLE") throw error;
      throw new LocalAgentDaemonClientError("DAEMON_UNAVAILABLE", "Local agent daemon is not running.");
    }
  }
}

export function createLocalAgentClient(config: Pick<ServerConfig, "stateDir">): LocalAgentClient {
  return new LocalAgentClient({ stateDir: config.stateDir });
}

export function spawnLocalAgentDaemon(stateDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const entrypoint = resolveDaemonEntrypoint();
  const child = spawn(process.execPath, [...process.execArgv, entrypoint], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, DEVSPACE_STATE_DIR: stateDir },
  });
  child.unref();
}

export function resolveDaemonEntrypoint(): string {
  const compiled = fileURLToPath(new URL("./local-agent-daemon-main.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  return fileURLToPath(new URL("./local-agent-daemon-main.ts", import.meta.url));
}

async function sendRequest(
  endpoint: string,
  request: LocalAgentDaemonRequest,
  timeoutMs: number,
): Promise<LocalAgentDaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new LocalAgentDaemonClientError("REQUEST_TIMEOUT", "Timed out waiting for the local agent daemon."), true);
    }, timeoutMs);

    const finish = (error?: unknown, destroy = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (destroy) socket.destroy();
      if (error) reject(error);
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = decodeLocalAgentDaemonResponse(JSON.parse(buffer.slice(0, newline)) as unknown);
        if (response.requestId !== request.requestId) {
          throw new LocalAgentDaemonProtocolError("INVALID_RESPONSE", "Daemon response request id did not match.");
        }
        settled = true;
        clearTimeout(timer);
        resolve(response);
        socket.end();
      } catch (error) {
        finish(error, true);
      }
    });
    socket.once("error", (error) => finish(new LocalAgentDaemonClientError(
      (error as NodeJS.ErrnoException).code ?? "DAEMON_UNAVAILABLE",
      error.message,
    )));
    socket.once("close", () => {
      if (!settled) finish(new LocalAgentDaemonClientError("DAEMON_UNAVAILABLE", "Local agent daemon closed the connection."));
    });
    socket.once("connect", () => socket.write(encodeLocalAgentDaemonRequest(request)));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
