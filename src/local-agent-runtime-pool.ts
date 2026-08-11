import { createHash } from "node:crypto";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export interface LocalAgentRuntimePoolLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

interface RuntimeEntry {
  readonly key: string;
  readonly driver: LocalAgentDriver;
  readonly idleTimeoutMs: number;
  readonly createPromise: Promise<LocalAgentRuntime>;
  runtime?: LocalAgentRuntime;
  activeRuns: number;
  lastUsedAt: number;
  closePromise?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
}

export interface LocalAgentRuntimePoolOptions {
  now?: () => number;
  logger?: LocalAgentRuntimePoolLogger;
}

/**
 * Owns live provider resources, not logical agent identity. Acquisition is
 * single-flight per runtime key and an entry is removed before its close
 * begins, so a new caller can never race with a closing runtime.
 */
export class LocalAgentRuntimePool {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly now: () => number;
  private readonly logger?: LocalAgentRuntimePoolLogger;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentRuntimePoolOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  async run(
    driver: LocalAgentDriver,
    context: LocalAgentRuntimeContext,
    input: LocalAgentRunInput,
  ): Promise<LocalAgentRunResult> {
    if (this.closing) throw new Error("Local agent runtime pool is closed.");

    let entry = await this.acquire(driver, context);
    let runtime = entry.runtime;
    if (!runtime) throw new Error("Local agent runtime was created without a runtime.");
    if (!runtime.isAlive()) {
      await this.removeAndClose(entry, "runtime_not_alive");
      entry = await this.acquire(driver, context);
      runtime = entry.runtime;
      if (!runtime || !runtime.isAlive()) {
        await this.removeAndClose(entry, "runtime_not_alive");
        throw new Error("Local agent runtime exited during startup.");
      }
    }

    this.clearIdleTimer(entry);
    entry.activeRuns += 1;
    const startedAt = this.now();
    try {
      return await runtime.run(input);
    } catch (error) {
      if (!runtime.isAlive()) {
        await this.removeAndClose(entry, "runtime_crashed");
        this.log("warn", "harness_runtime_crashed", {
          provider: driver.provider,
          runtimeKeyHash: hashRuntimeKey(entry.key),
          agentId: context.agentId,
          providerSessionIdPrefix: input.providerSessionId?.slice(0, 8),
          durationMs: Math.max(0, Math.round(this.now() - startedAt)),
          error: errorMessage(error),
        });
      }
      throw error;
    } finally {
      entry.activeRuns -= 1;
      entry.lastUsedAt = this.now();
      if (entry.activeRuns === 0 && !entry.closing) this.scheduleIdleClose(entry);
    }
  }

  /** Evict entries whose runtime has been idle beyond their driver's TTL. */
  async evictIdle(now = this.now()): Promise<void> {
    const evictions: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.closing || entry.activeRuns > 0 || !entry.runtime) continue;
      if (now - entry.lastUsedAt < entry.idleTimeoutMs) continue;
      evictions.push(this.removeAndClose(entry, "idle_timeout"));
    }
    await Promise.all(evictions);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    this.closePromise = Promise.all(entries.map((entry) => this.closeEntry(entry, "server_shutdown"))).then(() => undefined);
    return this.closePromise;
  }

  get size(): number {
    return this.entries.size;
  }

  private async acquire(
    driver: LocalAgentDriver,
    context: LocalAgentRuntimeContext,
  ): Promise<RuntimeEntry> {
    const key = driver.runtimeKey(context);
    const existing = this.entries.get(key);
    if (existing && !existing.closing) {
      if (!existing.runtime || existing.runtime.isAlive()) {
        this.clearIdleTimer(existing);
        if (existing.runtime) {
          this.log("info", "harness_runtime_reused", {
            provider: driver.provider,
            runtimeKeyHash: hashRuntimeKey(key),
            agentId: context.agentId,
          });
        }
        await existing.createPromise;
        if (existing.runtime?.isAlive()) return existing;
      }
      await this.removeAndClose(existing, "runtime_not_alive");
    }

    let entry!: RuntimeEntry;
    const createPromise = Promise.resolve()
      .then(() => driver.createRuntime(context))
      .then((runtime) => {
        entry.runtime = runtime;
        entry.lastUsedAt = this.now();
        this.log("info", "harness_runtime_started", {
          provider: driver.provider,
          runtimeKeyHash: hashRuntimeKey(key),
          agentId: context.agentId,
        });
        return runtime;
      })
      .catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });

    entry = {
      key,
      driver,
      idleTimeoutMs: driver.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      createPromise,
      activeRuns: 0,
      lastUsedAt: this.now(),
      closing: false,
    };
    this.entries.set(key, entry);
    await createPromise;
    return entry;
  }

  private scheduleIdleClose(entry: RuntimeEntry): void {
    this.clearIdleTimer(entry);
    if (!Number.isFinite(entry.idleTimeoutMs) || entry.idleTimeoutMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      void this.evictIdle().catch((error) => {
        this.log("warn", "harness_runtime_close_failed", {
          provider: entry.driver.provider,
          runtimeKeyHash: hashRuntimeKey(entry.key),
          reason: "idle_timeout",
          error: errorMessage(error),
        });
      });
    }, entry.idleTimeoutMs);
    entry.idleTimer.unref();
  }

  private clearIdleTimer(entry: RuntimeEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private async removeAndClose(entry: RuntimeEntry, reason: string): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    await this.closeEntry(entry, reason);
  }

  private async closeEntry(entry: RuntimeEntry, reason: string): Promise<void> {
    if (entry.closePromise) return entry.closePromise;
    entry.closing = true;
    this.clearIdleTimer(entry);
    entry.closePromise = (async () => {
      let runtime: LocalAgentRuntime;
      try {
        runtime = await entry.createPromise;
      } catch {
        return;
      }
      try {
        await runtime.close();
        this.log("info", "harness_runtime_closed", {
          provider: entry.driver.provider,
          runtimeKeyHash: hashRuntimeKey(entry.key),
          reason,
        });
      } catch (error) {
        this.log("warn", "harness_runtime_close_failed", {
          provider: entry.driver.provider,
          runtimeKeyHash: hashRuntimeKey(entry.key),
          reason,
          error: errorMessage(error),
        });
        throw error;
      }
    })();
    return entry.closePromise;
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

function hashRuntimeKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
