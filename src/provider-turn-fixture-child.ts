import { ProviderCallbackClient, type ProviderIpcEnvelope } from "./provider-turn-ipc.js";

/** Test-only Worker: imitates an SDK adapter without any paid inference.
 * It deliberately does not import createLocalAgentDrivers.
 */
const executionId = process.env.TASKQUAY_EXECUTION_ID!;
const generation = Number(process.env.TASKQUAY_EXECUTION_GENERATION);
let sequence = 0;
let running = false;
let controlFixture = false;
let controlFinished = false;
const send = (msg: Omit<ProviderIpcEnvelope, "executionId" | "generation" | "sequence">) => {
  process.send?.({ executionId, generation, sequence: ++sequence, ...msg });
};
const callbacks = new ProviderCallbackClient(executionId, generation,
  (msg) => process.send?.({ ...msg, sequence: ++sequence }));
process.on("message", (raw: unknown) => {
  const msg = raw as Partial<ProviderIpcEnvelope>;
  if (msg?.executionId !== executionId || msg.generation !== generation) return;
  if (msg.type === "CALLBACK_ACK") { callbacks.acknowledge(msg as ProviderIpcEnvelope); return; }
  if (msg.type === "CONTROL" && controlFixture) {
    if (msg.command === "steer") {
      send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: true,
        result: { turnId: "turn-fixture-steered" } });
    } else if (msg.command === "interrupt" && !controlFinished) {
      controlFinished = true;
      send({ type: "CONTROL_RESULT", requestId: msg.requestId, ok: true });
      send({ type: "PROVIDER_RESULT", ok: true, result: {
        provider: "codex", providerSessionId: "fake-session-resume-42",
        finalResponse: "FIXTURE:interrupted", items: [],
      } });
      process.disconnect?.();
    }
    return;
  }
  if (msg.type !== "GO" || running) return;
  running = true;
  const payload = msg.payload as { input?: { prompt?: string }; provider?: string;
    context?: { providerSessionId?: string | null } };
  const prompt = payload?.input?.prompt ?? "";
  // A real Provider creates a unique turn identity per turn. The test worker
  // must not reuse a prior turn ID under a resumed thread.
  const providerTurnId = `turn-fixture-${process.pid}`;
  const isContinuation = Boolean(payload.context?.providerSessionId);
  // The concurrency fixture starts distinct fresh Agent threads. A real
  // Provider must NOT reuse an unrelated thread identity across Agents.
  const threadId = payload.context?.providerSessionId ??
    (/gated-[0-3]|fifth-auto/.test(prompt)
      ? `fixture-thread-${process.pid}` : "fake-session-resume-42");
  void (async () => {
    try {
      await callbacks.invoke("onSessionId", threadId);
      await callbacks.invoke("onThreadInfo", {
        instanceId: "instance-fixture", identityVerified: true, threadId,
        createdHere: !isContinuation, priorTurnIds: [], priorTurnsClosed: !isContinuation,
      });
      await callbacks.invoke("onRequest");
      await callbacks.invoke("onTurnStarted", providerTurnId);
      if (prompt === "control" || prompt.endsWith("\ncontrol")) {
        controlFixture = true;
        await callbacks.invoke("onControlReady", {
          providerThreadId: threadId, providerTurnId,
        });
        return;
      }
      send({ type: "PROVIDER_RESULT", ok: true, result: {
        provider: payload.provider, providerSessionId: threadId,
        finalResponse: `FIXTURE:${prompt}`, items: [],
      } });
      if (prompt === "late-callback") {
        // Deliberate protocol violation, AFTER a positive terminal result.
        // The host MUST NOT dispatch a new AgentStore session callback.
        send({ type: "CALLBACK", requestId: "late-fixture",
          name: "onSessionId", value: "EVIL_OVERWRITE_AFTER_RESULT" });
      } else if (prompt === "wrong-generation") {
        process.send?.({ type: "CALLBACK", executionId,
          generation: generation + 1, sequence: ++sequence,
          requestId: "wrong-generation", name: "onSessionId",
          value: "EVIL_WRONG_GENERATION" });
      }
    } catch (error) {
      send({ type: "PROVIDER_RESULT", ok: false,
        error: { code: "CALLBACK_REJECTED", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (!controlFixture) process.disconnect?.();
    }
  })();
});
process.on("disconnect", () => process.exit(0));
send({ type: "READY" });
