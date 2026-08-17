import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  AcpLocalAgentDriver,
  AcpRuntime,
  acpCommandArgs,
  selectAcpPermissionOption,
} from "./local-agent-acp.js";

const requests: Array<{ method: string; params?: unknown }> = [];
const queues = new Map<string, { values: unknown[] }>();
const connection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        const sessionId = "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return {
          sessionId,
          configOptions: [
            { type: "select", category: "model", id: "model", options: [{ value: "model-a" }] },
            { type: "select", category: "thought_level", id: "thinking", options: [{ value: "high" }] },
          ],
        };
      }
      if (method === "session/resume") {
        const sessionId = input?.sessionId ?? "cursor_session_1";
        queues.set(sessionId, { values: [] });
        return { sessionId };
      }
      if (method === "session/prompt") {
        const queue = queues.get(input?.sessionId ?? "");
        queue?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ACP response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};

const sessionIds: string[] = [];
const runtime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: true, additionalDirectories: true },
  queues,
}, connection);

const first = await runtime.run({
  prompt: "first",
  workspace: "/tmp/project",
  model: "model-a",
  thinking: "high",
  writeMode: "read_only",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});
const warm = await runtime.run({
  prompt: "warm",
  workspace: "/tmp/project",
  providerSessionId: first.providerSessionId ?? undefined,
  model: "model-a",
  thinking: "high",
  writeMode: "full_access",
}, {
  onSessionId: (sessionId) => { sessionIds.push(sessionId); },
});

assert.equal(first.providerSessionId, "cursor_session_1");
assert.equal(warm.finalResponse, "ACP response");
assert.deepEqual(sessionIds, ["cursor_session_1", "cursor_session_1"]);
assert.equal(requests.filter(({ method }) => method === "session/new").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 0);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
assert.equal(
  Object.hasOwn(requests.find(({ method }) => method === "session/new")?.params as object, "additionalDirectories"),
  false,
);

await runtime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);
assert.equal(runtime.isAlive(), true);

const resumedRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: true, close: false },
  queues,
}, connection);
await assert.rejects(
  resumedRuntime.run({
    prompt: "resumed",
    workspace: "/tmp/project",
    providerSessionId: first.providerSessionId ?? undefined,
    model: "model-that-is-not-advertised-after-resume",
  }),
  /cannot apply the requested model override/,
  "a cold ACP override must fail instead of silently using the old configuration",
);
assert.equal(requests.filter(({ method }) => method === "session/resume").length, 1);
assert.equal(requests.filter(({ method }) => method === "session/set_config_option").length, 4);
await resumedRuntime.releaseSession("cursor_session_1");
assert.equal(queues.has("cursor_session_1"), false);
assert.equal(requests.filter(({ method }) => method === "session/close").length, 1);

const closeOnlyRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  capabilities: { resume: false, close: true },
}, connection);
await closeOnlyRuntime.releaseSession("close_only_session");
assert.equal(
  requests.filter(({ method, params }) => method === "session/close" && (params as { sessionId?: string })?.sessionId === "close_only_session").length,
  1,
  "session close support must not depend on resume support",
);
await closeOnlyRuntime.close();

assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed"),
  { optionId: "allow" },
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "read_only"),
  { optionId: "reject" },
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "allowed", "copilot"),
  undefined,
  "sandboxed Copilot permission requests must fail closed",
);
assert.equal(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], undefined),
  undefined,
  "permission requests for unknown ACP sessions must fail closed",
);
assert.deepEqual(
  selectAcpPermissionOption([
    { optionId: "allow", kind: "allow_once" },
    { optionId: "reject", kind: "reject_once" },
  ], "full_access", "copilot"),
  { optionId: "allow" },
);

const overlapQueues = new Map<string, { values: unknown[] }>();
let releaseOverlappingPrompt!: () => void;
let markPromptEntered!: () => void;
const overlappingPrompt = new Promise<void>((resolvePrompt) => { releaseOverlappingPrompt = resolvePrompt; });
const promptEntered = new Promise<void>((resolveEntered) => { markPromptEntered = resolveEntered; });
const overlapConnection = {
  agent: {
    async request(method: string, params?: unknown): Promise<unknown> {
      const input = params as { sessionId?: string } | undefined;
      if (method === "session/new") {
        overlapQueues.set("overlap_session", { values: [] });
        return { sessionId: "overlap_session" };
      }
      if (method === "session/prompt") {
        markPromptEntered();
        await overlappingPrompt;
        overlapQueues.get(input?.sessionId ?? "")?.values.push({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "overlap response" },
          },
        });
        return { stopReason: "end_turn" };
      }
      return {};
    },
  },
  close() {},
  closed: new Promise<void>(() => undefined),
};
const overlapRuntime = new AcpRuntime({
  provider: "cursor",
  command: "cursor-agent",
  args: ["acp"],
  env: {},
  queues: overlapQueues,
}, overlapConnection);
let overlapSessionId: string | undefined;
const firstOverlappingTurn = overlapRuntime.run({
  prompt: "first overlapping turn",
  workspace: "/tmp/project",
}, { onSessionId: (sessionId) => { overlapSessionId = sessionId; } });
await promptEntered;
await assert.rejects(
  overlapRuntime.run({
    prompt: "second overlapping turn",
    workspace: "/tmp/project",
    providerSessionId: overlapSessionId,
  }),
  /already has an active turn/,
);
releaseOverlappingPrompt();
assert.equal((await firstOverlappingTurn).finalResponse, "overlap response");
await overlapRuntime.close();

let resolverCalls = 0;
const cachedDriver = new AcpLocalAgentDriver("cursor", {}, () => {
  resolverCalls += 1;
  return "/usr/local/bin/cursor-agent";
});
const cachedContext = {
  agentId: "agt_acp",
  provider: "cursor" as const,
  workspace: "/tmp/project",
  writeMode: "allowed" as const,
};
const resolvedProject = resolve("/tmp/project");
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
assert.equal(cachedDriver.runtimeKey(cachedContext), `acp:cursor:/usr/local/bin/cursor-agent:allowed:${resolvedProject}`);
assert.equal(resolverCalls, 1, "ACP executable identity is resolved once per driver lifecycle");
assert.deepEqual(acpCommandArgs("cursor", cachedContext), [
  "acp", "--sandbox", "enabled", "--workspace", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("copilot", cachedContext), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject,
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "read_only" }), [
  "--acp", "--experimental", "--sandbox", "--allow-all-tools", "--add-dir", resolvedProject, "-C", resolvedProject, "--mode", "plan",
]);
assert.deepEqual(acpCommandArgs("copilot", { ...cachedContext, writeMode: "full_access" }), [
  "--acp", "--no-sandbox", "--allow-all", "-C", resolvedProject,
]);

await resumedRuntime.close();
await resumedRuntime.close();
assert.equal(resumedRuntime.isAlive(), false);
