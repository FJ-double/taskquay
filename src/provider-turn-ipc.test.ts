import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCallbackClient, ProviderCallbackFence, type ProviderIpcEnvelope } from "./provider-turn-ipc.js";

const ex = "ex_0123456789abcdef0123456789abcdef";
const until = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("session identity, request and thread callbacks require host persistence ACK", async () => {
  const trace: string[] = [];
  let commit!: () => void;
  const persisted = new Promise<void>((resolve) => { commit = resolve; });
  const hostOut: ProviderIpcEnvelope[] = [];
  const child = new ProviderCallbackClient(ex, 2, (m) => { void host.receive(m); });
  const host = new ProviderCallbackFence(ex, 2, {
    onSessionId: async (id) => { trace.push(`session:${id}`); await persisted; },
    onThreadInfo: () => { trace.push("thread"); },
    onRequest: () => { trace.push("requested"); },
  }, (m) => { hostOut.push(m); child.acknowledge(m); });
  let settled = false;
  const first = child.invoke("onSessionId", "provider-thread-42").then(() => { settled = true; });
  await until();
  assert.deepEqual(trace, ["session:provider-thread-42"]);
  assert.equal(settled, false, "Provider must wait for host commit before dispatch.");
  commit();
  await first;
  assert.equal(settled, true);
  await child.invoke("onThreadInfo", { instanceId: "x", identityVerified: true, threadId: "provider-thread-42", createdHere: true, priorTurnIds: [], priorTurnsClosed: true });
  await child.invoke("onRequest");
  assert.deepEqual(trace, ["session:provider-thread-42", "thread", "requested"]);
  assert.equal(child.pending, 0);
  assert.equal(hostOut.length, 3);
});

test("failed ledger persistence rejects provider callback and wrong generation is ignored", async () => {
  const hostMessages: ProviderIpcEnvelope[] = [];
  const host = new ProviderCallbackFence(ex, 1, {
    onSessionId: () => { throw new Error("PERSISTENCE_FAILED"); },
  }, (m) => { hostMessages.push(m); child.acknowledge(m); });
  const child = new ProviderCallbackClient(ex, 1, (m) => { void host.receive(m); });
  await assert.rejects(child.invoke("onSessionId", "s"), /PERSISTENCE_FAILED/);
  assert.equal(child.pending, 0);
  assert.equal(hostMessages[0]?.ok, false);
  const ignored = await host.receive({ type: "CALLBACK", executionId: ex, generation: 0,
    sequence: 2, requestId: "stale", name: "onRequest" });
  assert.equal(ignored, false);
  const replay = await host.receive({ type: "CALLBACK", executionId: ex, generation: 1,
    sequence: 1, requestId: "cb_1", name: "onSessionId", value: "s" });
  assert.equal(replay, false, "Duplicate callback sequence cannot be replayed.");
});

test("unknown callback type never becomes a success ACK", async () => {
  const replies: ProviderIpcEnvelope[] = [];
  const fence = new ProviderCallbackFence(ex, 1, {}, (m) => replies.push(m));
  assert.equal(await fence.receive({ type: "CALLBACK", executionId: ex, generation: 1, sequence: 1,
    requestId: "unknown", name: "onSecretHook" }), true);
  assert.equal(replies[0]?.ok, false);
  assert.match(String(replies[0]?.error), /Unknown/);
});

test("missing callback ACK times out rather than deadlocking inference", async () => {
  const client = new ProviderCallbackClient(ex, 1, () => {}, 25);
  await assert.rejects(client.invoke("onSessionId", "pending"), /PROVIDER_CALLBACK_ACK_TIMEOUT/);
  assert.equal(client.pending, 0);
});

test("host serializes pipelined session and request callbacks until session persistence commits", async () => {
  let commit!: () => void;
  const deferred = new Promise<void>((resolve) => { commit = resolve; });
  const trace: string[] = [];
  const replies: ProviderIpcEnvelope[] = [];
  const fence = new ProviderCallbackFence(ex, 3, {
    onSessionId: async () => { trace.push("persisting-session"); await deferred; trace.push("session-committed"); },
    onRequest: () => { trace.push("model-request"); },
  }, (message) => { replies.push(message); });
  const session = fence.receive({ type: "CALLBACK", executionId: ex, generation: 3,
    sequence: 1, requestId: "first", name: "onSessionId", value: "thread" });
  const request = fence.receive({ type: "CALLBACK", executionId: ex, generation: 3,
    sequence: 2, requestId: "second", name: "onRequest" });
  await until();
  assert.deepEqual(trace, ["persisting-session"]);
  assert.equal(replies.length, 0);
  commit();
  await Promise.all([session, request]);
  assert.deepEqual(trace, ["persisting-session", "session-committed", "model-request"]);
  assert.deepEqual(replies.map((m) => m.ok), [true, true]);
  fence.close();
  assert.equal(await fence.receive({ type: "CALLBACK", executionId: ex, generation: 3,
    sequence: 3, requestId: "late", name: "onSessionId", value: "MUST_NOT_COMMIT" }), false);
  assert.equal(replies.length, 2);
});

test("a pipelined model request cannot execute after session persistence fails", async () => {
  const replies: ProviderIpcEnvelope[] = [];
  let modelRequested = false;
  const fence = new ProviderCallbackFence(ex, 4, {
    onSessionId: () => { throw new Error("SESSION_DATABASE_FAILURE"); },
    onRequest: () => { modelRequested = true; },
  }, (msg) => { replies.push(msg); });
  await Promise.all([
    fence.receive({ type: "CALLBACK", executionId: ex, generation: 4,
      sequence: 1, requestId: "one", name: "onSessionId", value: "unsafe" }),
    fence.receive({ type: "CALLBACK", executionId: ex, generation: 4,
      sequence: 2, requestId: "two", name: "onRequest" }),
  ]);
  assert.equal(modelRequested, false);
  assert.deepEqual(replies.map((r) => r.ok), [false, false]);
  assert.match(String(replies[1]?.error), /PROVIDER_CALLBACK_CHAIN_ABORTED/);
  assert.match(fence.failure?.message ?? "", /PROVIDER_CALLBACK_PERSISTENCE_FAILED/);
});
