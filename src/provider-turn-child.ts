import type { LocalAgentRunCallbacks, LocalAgentRunInput, LocalAgentRuntimeContext, LocalAgentTurnControl } from "./local-agent-runtime.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { ProviderCallbackClient, type ProviderCallbackName, type ProviderIpcEnvelope } from "./provider-turn-ipc.js";

/** Per-turn process. Must not import any Provider SDK before receiving GO:
 * this bootstrap can be spawned and placed in its own Job without inference.
 */
const executionId = process.env.TASKQUAY_EXECUTION_ID ?? "";
const generation = Number(process.env.TASKQUAY_EXECUTION_GENERATION);
if (!/^ex_[a-f0-9]{32}$/.test(executionId) || !Number.isSafeInteger(generation) ||
    generation < 1 || !process.send) {
  process.exitCode = 127;
} else {
  let outgoingSequence = 0;
  let incomingSequence = 0;
  let begun = false;
  let turnControl: LocalAgentTurnControl | undefined;
  let runtimeClose: (() => Promise<void>) | undefined;
  let callbackFault: Error | undefined;
  const send = (message: Omit<ProviderIpcEnvelope, "executionId" | "generation" | "sequence">) => {
    process.send?.({ executionId, generation, sequence: ++outgoingSequence, ...message });
  };
  // CallbackClient is its own ordered source. All outgoing IPC sequence
  // numbers must be assigned from ONE counter, including callback events.
  const callbacksClient = new ProviderCallbackClient(executionId, generation, (m) => {
    process.send?.({ ...m, sequence: ++outgoingSequence });
  });
  const required = (name: ProviderCallbackName, value?: unknown) => callbacksClient.invoke(name, value);
  const optional = (name: ProviderCallbackName, value?: unknown): void => {
    void required(name, value).catch((error: unknown) => {
      callbackFault ??= error instanceof Error ? error : new Error(String(error));
    });
  };
  const callbacks: LocalAgentRunCallbacks = {
    onNotRequested: () => optional("onNotRequested"),
    onThreadInfo: (value) => required("onThreadInfo", value),
    onNameResult: (value) => optional("onNameResult", value),
    onRequest: () => required("onRequest"),
    onTurnStarted: (value) => required("onTurnStarted", value),
    onControlReady: async (control) => {
      turnControl = control;
      await required("onControlReady",
        { providerThreadId: control.providerThreadId, providerTurnId: control.providerTurnId });
    },
    onProviderFinished: () => optional("onProviderFinished"),
    onUsage: (value) => optional("onUsage", value),
    onActivity: (value) => optional("onActivity", value),
    onSessionId: (value) => required("onSessionId", value),
    onHistoryHandoff: (value) => required("onHistoryHandoff", value),
  };
  async function run(value: unknown) {
    const payload = value as { provider?: LocalAgentProvider; context?: LocalAgentRuntimeContext;
      input?: LocalAgentRunInput; providerEnv?: Record<string, string>; subagents?: SubagentsConfig };
    if (!payload?.provider || !payload.context || !payload.input ||
        payload.context.provider !== payload.provider) throw new Error("Invalid Provider dispatch identity.");
    // The actual Provider adapter must be constructed INSIDE the Job, and only after GO.
    const { createLocalAgentDrivers } = await import("./local-agent-adapters.js");
    const drivers = createLocalAgentDrivers({ env: { ...process.env, ...payload.providerEnv },
      subagents: payload.subagents });
    const driver = drivers.find((entry) => entry.provider === payload.provider);
    if (!driver) throw new Error("Unknown Provider adapter.");
    const created = await driver.createRuntime(payload.context);
    if (created.isErr()) {
      send({ type: "PROVIDER_RESULT", ok: false, error: {
        code: created.error.code, message: created.error.message, retryable: created.error.retryable,
      } });
      return;
    }
    const runtime = created.value;
    runtimeClose = async () => { await runtime.close(); };
    try {
      const result = await runtime.run(payload.input, callbacks);
      // All non-awaited adapter callbacks are still part of the durable receipt.
      for (let tries = 0; callbacksClient.pending > 0 && tries < 200; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (callbackFault || callbacksClient.pending > 0) throw callbackFault ?? new Error("Provider callback ACK timeout.");
      if (result.isErr()) {
        send({ type: "PROVIDER_RESULT", ok: false, error: {
          code: result.error.code, message: result.error.message, retryable: result.error.retryable,
        } });
      } else {
        send({ type: "PROVIDER_RESULT", ok: true, result: result.value });
      }
    } finally {
      await runtime.close();
      runtimeClose = undefined;
    }
  }
  process.on("message", (raw: unknown) => {
    const msg = raw as Partial<ProviderIpcEnvelope>;
    if (msg?.executionId !== executionId || msg.generation !== generation ||
        !Number.isSafeInteger(msg.sequence)) return;
    if (msg.type === "CALLBACK_ACK") { callbacksClient.acknowledge(msg as ProviderIpcEnvelope); return; }
    if (msg.sequence! <= incomingSequence) return;
    incomingSequence = msg.sequence!;
    if (msg.type === "GO" && !begun) {
      begun = true;
      void run(msg.payload).catch((error: unknown) => {
        send({ type: "PROVIDER_RESULT", ok: false, error: {
          code: "PROVIDER_ISOLATED_ERROR",
          message: error instanceof Error ? error.message : "Provider process error.",
          retryable: false,
        } });
      }).finally(() => {
        callbacksClient.failAll("Provider turn has ended.");
        // Close provider-owned resources first; parent verifies an EMPTY Job.
        process.disconnect?.();
      });
    } else if (msg.type === "CONTROL" && turnControl) {
      void (async () => {
        try {
          if (msg.command === "interrupt") {
            await turnControl.interrupt();
            send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: true });
          } else if (msg.command === "steer" && typeof msg.prompt === "string") {
            const result = await turnControl.steer(msg.prompt);
            send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: true, result });
          } else {
            send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: false, error: "Unknown turn control." });
          }
        } catch (error) {
          send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: false,
            error: error instanceof Error ? error.message : "Turn control failed." });
        }
      })();
    }
  });
  process.on("disconnect", () => {
    callbacksClient.failAll("Provider owner disconnected.");
    void runtimeClose?.().finally(() => process.exit(125));
  });
  send({ type: "READY" });
}
