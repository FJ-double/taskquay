import { appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import {
  LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  LocalAgentDaemonAlreadyRunningError,
  LocalAgentDaemonLock,
  ensureLocalAgentDaemonStateDir,
  localAgentDaemonPaths,
  removeLocalAgentDaemonFiles,
  type LocalAgentDaemonPaths,
} from "./local-agent-daemon-lifecycle.js";
import {
  decodeLocalAgentDaemonRequest,
  encodeLocalAgentDaemonResponse,
  type LocalAgentDaemonRequest,
  type LocalAgentDaemonResponse,
  type LocalAgentDaemonStatus,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";
import type { RunOverrides, StartLocalAgentInput } from "./local-agent-manager.js";
import type { LocalAgentListScope, LocalAgentRecord } from "./local-agent-store.js";

const MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_DAEMON_IDLE_SHUTDOWN_MS = 30_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 1_000;

export interface LocalAgentDaemonManager {
  start(input: StartLocalAgentInput): Promise<LocalAgentRecord>;
  continue(agentId: string, prompt: string, overrides?: RunOverrides): Promise<LocalAgentRecord>;
  get(agentId: string): LocalAgentRecord | undefined;
  list(scope?: LocalAgentListScope): LocalAgentRecord[];
  evictIdle(now?: number): Promise<void>;
  close(): Promise<void>;
  readonly activeTurnCount: number;
  readonly runtimeCount: number;
}

export interface LocalAgentDaemonOptions {
  stateDir: string;
  manager: LocalAgentDaemonManager;
  idleShutdownMs?: number;
  idleCheckIntervalMs?: number;
  now?: () => number;
  paths?: LocalAgentDaemonPaths;
}

export class LocalAgentDaemon {
  readonly paths: LocalAgentDaemonPaths;
  private readonly manager: LocalAgentDaemonManager;
  private readonly lock: LocalAgentDaemonLock;
  private readonly idleShutdownMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly now: () => number;
  private readonly sockets = new Set<Socket>();
  private server?: NetServer;
  private idleTimer?: NodeJS.Timeout;
  private idleSince?: number;
  private closePromise?: Promise<void>;
  private startedAt?: string;
  private accepting = false;
  private stopping = false;

  constructor(options: LocalAgentDaemonOptions) {
    this.paths = options.paths ?? localAgentDaemonPaths(options.stateDir);
    this.manager = options.manager;
    this.lock = new LocalAgentDaemonLock(this.paths);
    this.idleShutdownMs = options.idleShutdownMs ?? DEFAULT_DAEMON_IDLE_SHUTDOWN_MS;
    this.idleCheckIntervalMs = options.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.idleShutdownMs) || this.idleShutdownMs < 0) {
      throw new Error("Agent daemon idle shutdown must be a non-negative finite duration.");
    }
  }

  async start(): Promise<LocalAgentDaemonStatus> {
    if (this.server) return this.status();
    ensureLocalAgentDaemonStateDir(this.paths.stateDir);
    try {
      this.lock.acquire();
      if (process.platform !== "win32") rmSync(this.paths.socketPath, { force: true });
      const server = createServer((socket) => this.handleConnection(socket));
      this.server = server;
      await listen(server, this.paths.endpoint);
      if (process.platform !== "win32") chmodSync(this.paths.socketPath, 0o600);
      this.startedAt = new Date(this.now()).toISOString();
      this.accepting = true;
      this.stopping = false;
      this.idleTimer = setInterval(() => {
        void this.maintainIdle().catch((error) => {
          writeLocalAgentDaemonLog(this.paths, "warn", "daemon_idle_check_failed", {
            error: errorMessage(error),
          });
        });
      }, this.idleCheckIntervalMs);
      this.idleTimer.unref();
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_started", { pid: process.pid });
      return this.status();
    } catch (error) {
      this.server = undefined;
      this.lock.release();
      removeLocalAgentDaemonFiles(this.paths);
      if (error instanceof LocalAgentDaemonAlreadyRunningError) throw error;
      throw error;
    }
  }

  status(): LocalAgentDaemonStatus {
    if (!this.startedAt) throw new Error("Local agent daemon is not started.");
    return {
      state: this.stopping ? "stopping" : "ready",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      endpoint: this.paths.endpoint,
      startedAt: this.startedAt,
      activeTurns: this.manager.activeTurnCount,
      runtimeCount: this.manager.runtimeCount,
      clientConnections: this.sockets.size,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.closePromise = (async () => {
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_stopping", {
        activeTurns: this.manager.activeTurnCount,
        runtimeCount: this.manager.runtimeCount,
      });
      const [serverResult, managerResult] = await Promise.allSettled([
        closeServer(this.server),
        this.manager.close(),
      ]);
      if (serverResult.status === "rejected") {
        writeLocalAgentDaemonLog(this.paths, "warn", "daemon_socket_close_failed", {
          error: errorMessage(serverResult.reason),
        });
      }
      if (managerResult.status === "rejected") {
        writeLocalAgentDaemonLog(this.paths, "warn", "daemon_manager_close_failed", {
          error: errorMessage(managerResult.reason),
        });
      }
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      removeLocalAgentDaemonFiles(this.paths);
      this.lock.release();
      writeLocalAgentDaemonLog(this.paths, "info", "daemon_stopped", {});
      this.server = undefined;
    })();
    return this.closePromise;
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string | Buffer) => {
      if (handled) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        this.writeError(socket, "", "REQUEST_TOO_LARGE", "Daemon request is too large.");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      const line = buffer.slice(0, newline);
      void this.handleLine(socket, line);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let requestId = "";
    try {
      const parsed: unknown = JSON.parse(line);
      requestId = readRequestId(parsed);
      const request = decodeLocalAgentDaemonRequest(parsed);
      const response = await this.dispatch(request);
      socket.end(encodeLocalAgentDaemonResponse({
        requestId: request.requestId,
        protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
        ok: true,
        result: response,
      }));
      if (request.method === "daemon.stop") setImmediate(() => { void this.close(); });
    } catch (error) {
      this.writeError(socket, requestId, errorCode(error), errorMessage(error));
    }
  }

  private async dispatch(request: LocalAgentDaemonRequest): Promise<unknown> {
    if (request.protocolVersion !== LOCAL_AGENT_DAEMON_PROTOCOL_VERSION) {
      throw new LocalAgentDaemonProtocolError(
        "PROTOCOL_MISMATCH",
        `Unsupported daemon protocol version ${request.protocolVersion}; expected ${LOCAL_AGENT_DAEMON_PROTOCOL_VERSION}.`,
      );
    }
    if (!this.accepting && request.method !== "hello" && request.method !== "daemon.status") {
      throw new Error("Local agent daemon is stopping.");
    }

    switch (request.method) {
      case "hello":
        return this.status();
      case "agent.run": {
        const existing = this.manager.get(request.params.target);
        return existing
          ? this.manager.continue(request.params.target, request.params.prompt, {
              model: request.params.model,
              thinking: request.params.thinking,
              writeMode: request.params.writeMode,
            })
          : this.manager.start(request.params);
      }
      case "agent.start":
        return this.manager.start(request.params);
      case "agent.continue":
        return this.manager.continue(request.params.id, request.params.prompt, request.params.overrides);
      case "agent.get":
        return this.manager.get(request.params.id) ?? null;
      case "agent.list":
        return this.manager.list(request.params);
      case "daemon.status":
        return this.status();
      case "daemon.stop":
        this.stopping = true;
        this.accepting = false;
        return this.status();
      case "daemon.logs":
        return readLocalAgentDaemonLogs(this.paths, request.params.lines);
    }
  }

  private writeError(socket: Socket, requestId: string, code: string, message: string): void {
    socket.end(encodeLocalAgentDaemonResponse({
      requestId,
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      ok: false,
      error: { code, message },
    }));
  }

  private async maintainIdle(): Promise<void> {
    await this.manager.evictIdle(this.now());
    if (this.stopping || this.manager.activeTurnCount > 0 || this.manager.runtimeCount > 0 || this.sockets.size > 0) {
      this.idleSince = undefined;
      return;
    }
    const now = this.now();
    this.idleSince ??= now;
    if (now - this.idleSince >= this.idleShutdownMs) await this.close();
  }
}

async function listen(server: NetServer, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

async function closeServer(server: NetServer | undefined): Promise<void> {
  if (!server) return;
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readRequestId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : "";
}

function errorCode(error: unknown): string {
  if (error instanceof LocalAgentDaemonProtocolError) return error.code;
  if (errorMessage(error).includes("already has a running turn")) return "CONFLICT";
  if (errorMessage(error).includes("is stopping")) return "DAEMON_STOPPING";
  return "AGENT_ERROR";
}

export function writeLocalAgentDaemonLog(
  paths: LocalAgentDaemonPaths,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    ensureLocalAgentDaemonStateDir(paths.stateDir);
    appendFileSync(paths.logPath, `${JSON.stringify({ at: new Date().toISOString(), level, event, ...fields })}\n`, { mode: 0o600 });
    chmodSync(paths.logPath, 0o600);
  } catch {
    // Diagnostics must never break agent execution or shutdown.
  }
}

export function readLocalAgentDaemonLogs(paths: LocalAgentDaemonPaths, lines = 200): string {
  try {
    const content = readFileSync(paths.logPath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, lines)).join("\n");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
