import assert from "node:assert/strict";
import test from "node:test";
import { claudePrintArgs, claudePrintResult } from "./local-agent-claude-cli.js";

test("Claude CLI read-only invocation excludes shell and file edits", () => {
  const args = claudePrintArgs({ prompt: "Review changes", workspaceRoot: "C:\\repo", writeMode: "read_only" });
  assert(args.includes("--restricted"));
  assert(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.deepEqual(args.slice(-2), ["--", "Review changes"]);
});

test("Claude CLI workspace edits permit file tools but not shell or network tools", () => {
  const args = claudePrintArgs({ prompt: "-plain", workspaceRoot: "C:\\repo", writeMode: "allowed",
    providerSessionId: "session-one", model: "sonnet", effort: "medium" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write");
  assert.deepEqual(args.slice(-2), ["--", "-plain"]);
  assert.equal(args[args.indexOf("--resume") + 1], "session-one");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
});

test("Claude CLI parses structured result and rejects provider errors", () => {
  assert.deepEqual(claudePrintResult(JSON.stringify({ type: "result", subtype: "success",
    result: "QA_OK", session_id: "abc", is_error: false })),
  { response: "QA_OK", sessionId: "abc" });
  assert.throws(() => claudePrintResult(JSON.stringify({ type: "result", subtype: "error", is_error: true,
    result: "provider failed" })), /provider failed/);
  assert.throws(() => claudePrintResult(JSON.stringify({ type: "result", subtype: "success", is_error: true,
    result: "Not logged in · Please run \/login" })), /Not logged in/);
  assert.throws(() => claudePrintResult('{"type":"unexpected","result":"x"}'), /unexpected response/);
});
