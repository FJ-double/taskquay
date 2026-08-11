import assert from "node:assert/strict";
import {
  decodeAgentRecord,
  decodeLocalAgentDaemonRequest,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonRequest,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";

const request = decodeLocalAgentDaemonRequest({
  requestId: "req_1",
  protocolVersion: 1,
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceRoot: "/tmp/project",
    writeMode: "read_only",
  },
});
assert.equal(request.method, "agent.start");
assert.equal(request.params.writeMode, "read_only");
assert.match(encodeLocalAgentDaemonRequest(request), /"method":"agent.start"/);

assert.throws(
  () => decodeLocalAgentDaemonRequest({
    requestId: "req_2",
    protocolVersion: 1,
    method: "agent.start",
    params: { target: "reviewer", prompt: "" },
  }),
  (error: unknown) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
);

const record = decodeAgentRecord({
  id: "agt_1234",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "idle",
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(record.id, "agt_1234");

const response = decodeLocalAgentDaemonResponse({
  requestId: "req_1",
  protocolVersion: 1,
  ok: true,
  result: record,
});
assert.equal(response.ok, true);
