import assert from "node:assert/strict";
import { toolIcons } from "./icons.js";
import { getToolDisplay, getToolHeaderSummary } from "./tool-display.js";

assert.deepEqual(
  pickDisplay(getToolDisplay({
    tool: "show_changes",
    files: [
      { path: "src/a.ts", operation: "update" },
      { path: "src/b.ts", operation: "update" },
    ],
  })),
  { title: "Edited 2 files", tone: "review" },
);

assert.deepEqual(
  pickDisplay(getToolDisplay({
    tool: "show_changes",
    files: [
      { path: "src/a.ts", operation: "add" },
      { path: "src/b.ts", operation: "update" },
    ],
  })),
  { title: "Changed 2 files", tone: "review" },
);

assert.equal(
  getToolDisplay({ tool: "exec_command", summary: { running: true, command: "npm test" } }).title,
  "Command running",
);
assert.equal(
  getToolDisplay({ tool: "exec_command", summary: { running: false, exitCode: 1 } }).title,
  "Command failed",
);
assert.equal(
  getToolDisplay({ tool: "write_stdin", summary: { running: false, exitCode: 0 } }).title,
  "Process finished",
);

assert.deepEqual(
  pickDisplay(getToolDisplay({ tool: "glob", summary: { lines: 1, pattern: "**/*.ts" } })),
  { title: "Found files", tone: "search" },
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "glob", summary: { lines: 1 } }),
  { kind: "empty" },
);

assert.equal(
  getToolDisplay({
    tool: "apply_patch",
    files: [{ path: "src/removed.ts", operation: "delete" }],
  }).icon,
  toolIcons.deleteFile,
);

assert.deepEqual(
  getToolHeaderSummary({ tool: "show_changes", summary: { additions: 14, removals: 1 } }),
  { kind: "diff", additions: 14, removals: 1 },
);

assert.deepEqual(
  getToolHeaderSummary({
    tool: "open_workspace",
    summary: { mode: "worktree", agentsFiles: 1, skills: 4 },
  }),
  { kind: "text", text: "worktree · 1 instruction · 4 skills" },
);

function pickDisplay(display: ReturnType<typeof getToolDisplay>) {
  return {
    title: display.title,
    tone: display.tone,
  };
}
