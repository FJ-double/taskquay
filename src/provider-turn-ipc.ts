import type { LocalAgentRunCallbacks, LocalAgentTurnControl } from "./local-agent-runtime.js";

export const PROVIDER_CALLBACK_NAMES = [
  "onNotRequested", "onThreadInfo", "onNameResult", "onRequest",
  "onTurnStarted", "onControlReady", "onProviderFinished", "onUsage",
  "onActivity", "onSessionId", "onHistoryHandoff",
] as const;

export type ProviderCallbackName = typeof PROVIDER_CALLBACK_NAMES[number];
export interface ProviderIpcEnvelope {
  executionId: string;
  generation: number;
  sequence: number;
  type: string;
  requestId?: string;
  [key: string]: unknown;
}
export type ProviderIpcSend = (message: ProviderIpcEnvelope) => void;

/**
 * Durable events are never acknowledged until the parent callback returns.
 * Reject out-of-order or wrong-generation messages, even if their request ID
 * is otherwise valid. An ACK failure is fatal to an awaited child callback.
 */
export class ProviderCallbackFence {
  private highestSequence = 0;
  private nextSequence = 0;
  private readonly seenRequests = new Set<string>();
  private callbackQueue: Promise<void> = Promise.resolve();
  private terminal = false;
  private callbackFailure?: Error;
  get failure(): Error | undefined { return this.callbackFailure; }
  close(): void { this.terminal = true; }
  constructor(
    private readonly executionId: string,
    private readonly generation: number,
    private readonly callbacks: LocalAgentRunCallbacks,
    private readonly send: ProviderIpcSend,
    private readonly controlFactory?: (threadId: string, turnId: string) => LocalAgentTurnControl,
  ) {}

  async receive(message: ProviderIpcEnvelope): Promise<boolean> {
    if (this.terminal || message.executionId !== this.executionId || message.generation !== this.generation) return false;
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= this.highestSequence) return false;
    this.highestSequence = message.sequence;
    if (message.type !== "CALLBACK") return false;
    if (typeof message.requestId !== "string" || !message.requestId ||
        this.seenRequests.has(message.requestId)) return false;
    this.seenRequests.add(message.requestId);
    // A sender may pipeline IPC messages without waiting for ACK. Serialize
    // host callbacks so onRequest cannot overtake an uncommitted session ID.
    const accepted = this.callbackQueue.then(() => this.persistAndReply(message));
    this.callbackQueue = accepted.then(() => undefined, () => undefined);
    await accepted;
    return true;
  }

  private async persistAndReply(message: ProviderIpcEnvelope): Promise<void> {
    // Validated before enqueuing by receive().
    const requestId = message.requestId!;
    if (this.callbackFailure) {
      // A pipelined request must never jump ahead of a failed session or
      // turn identity commit. The caller must reconcile this execution.
      this.reply(requestId, false, "PROVIDER_CALLBACK_CHAIN_ABORTED");
      return;
    }
    if (!PROVIDER_CALLBACK_NAMES.includes(message.name as ProviderCallbackName)) {
      this.callbackFailure ??= new Error("PROVIDER_UNKNOWN_CALLBACK");
      this.reply(requestId, false, "Unknown provider callback.");
      return;
    }
    const name = message.name as ProviderCallbackName;
    try {
      const value = message.value;
      switch (name) {
        case "onNotRequested": await this.callbacks.onNotRequested?.(); break;
        case "onThreadInfo": await this.callbacks.onThreadInfo?.(value as Parameters<NonNullable<LocalAgentRunCallbacks["onThreadInfo"]>>[0]); break;
        case "onNameResult": await this.callbacks.onNameResult?.(value === true); break;
        case "onRequest": await this.callbacks.onRequest?.(); break;
        case "onTurnStarted": {
          if (typeof value !== "string" || !value) throw new Error("Invalid provider turn ID.");
          await this.callbacks.onTurnStarted?.(value); break;
        }
        case "onControlReady": {
          const val = value as { providerThreadId?: unknown; providerTurnId?: unknown } | null;
          if (!val || typeof val.providerThreadId !== "string" ||
              typeof val.providerTurnId !== "string" || !this.controlFactory) {
            throw new Error("Invalid remote turn control.");
          }
          await this.callbacks.onControlReady?.(this.controlFactory(val.providerThreadId, val.providerTurnId));
          break;
        }
        case "onProviderFinished": await this.callbacks.onProviderFinished?.(); break;
        case "onUsage": await this.callbacks.onUsage?.(value as Parameters<NonNullable<LocalAgentRunCallbacks["onUsage"]>>[0]); break;
        case "onActivity": await this.callbacks.onActivity?.(value as Parameters<NonNullable<LocalAgentRunCallbacks["onActivity"]>>[0]); break;
        case "onSessionId": {
          if (typeof value !== "string" || !value) throw new Error("Invalid provider session ID.");
          await this.callbacks.onSessionId?.(value); break;
        }
        case "onHistoryHandoff": {
          const handoff = value as { type?: unknown; parentThreadId?: unknown; threadId?: unknown } | null;
          if (!handoff || handoff.type !== "fresh_thread_handoff" ||
              typeof handoff.parentThreadId !== "string" || typeof handoff.threadId !== "string") {
            throw new Error("Invalid provider history handoff.");
          }
          await this.callbacks.onHistoryHandoff?.(handoff as { type: "fresh_thread_handoff"; parentThreadId: string; threadId: string });
          break;
        }
      }
      this.reply(requestId, true);
    } catch (error) {
      this.callbackFailure ??= new Error("PROVIDER_CALLBACK_PERSISTENCE_FAILED", { cause: error });
      this.reply(requestId, false, error instanceof Error ? error.message : "Provider callback persistence failed.");
    }
  }

  private reply(requestId: string, ok: boolean, error?: string) {
    this.send({ type: "CALLBACK_ACK", executionId: this.executionId, generation: this.generation,
      sequence: ++this.nextSequence, requestId, ok, ...(error ? { error } : {}) });
  }
}

/** Child side — call send() only after the IPC channel is established.
 * Every callback that influences provider lifecycle must await the ACK.
 */
export class ProviderCallbackClient {
  private sequence = 0;
  private nextId = 0;
  private readonly outstanding = new Map<string, {
    resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout;
  }>();
  constructor(
    private readonly executionId: string, private readonly generation: number,
    private readonly send: ProviderIpcSend,
    private readonly callbackTimeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs < 1 || callbackTimeoutMs > 300_000) {
      throw new Error("Invalid Provider callback ACK timeout.");
    }
  }
  invoke(name: ProviderCallbackName, value?: unknown): Promise<void> {
    if (this.outstanding.size >= 64) return Promise.reject(new Error("PROVIDER_CALLBACK_QUEUE_FULL"));
    const requestId = `cb_${++this.nextId}`;
    const pending = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.outstanding.delete(requestId);
        reject(new Error("PROVIDER_CALLBACK_ACK_TIMEOUT: no durable host acknowledgment."));
      }, this.callbackTimeoutMs);
      this.outstanding.set(requestId, { resolve, reject, timeout });
    });
    this.send({ type: "CALLBACK", executionId: this.executionId, generation: this.generation,
      sequence: ++this.sequence, requestId, name, value });
    return pending;
  }
  acknowledge(message: ProviderIpcEnvelope): boolean {
    if (message.type !== "CALLBACK_ACK" || message.executionId !== this.executionId ||
        message.generation !== this.generation || typeof message.requestId !== "string") return false;
    const pending = this.outstanding.get(message.requestId);
    if (!pending) return false;
    this.outstanding.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.ok === true) pending.resolve();
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "Callback rejected."));
    return true;
  }
  failAll(reason: string): void {
    for (const pending of this.outstanding.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.outstanding.clear();
  }
  get pending() { return this.outstanding.size; }
}
