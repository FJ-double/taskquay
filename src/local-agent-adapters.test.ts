import assert from "node:assert/strict";
import {
  createLocalAgentAdapter,
  extractLocalAgentResponseText,
} from "./local-agent-adapters.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

const providers: LocalAgentProvider[] = [
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
];

for (const provider of providers) {
  const adapter = createLocalAgentAdapter(provider);
  assert.equal(adapter.provider, provider);
  assert.equal(typeof adapter.run, "function");
}

assert.equal(
  extractLocalAgentResponseText({
    messages: [
      { role: "assistant", content: "I will inspect the code." },
      { role: "tool", content: "rg -n secret src" },
      { role: "assistant", content: "Final review only." },
    ],
  }),
  "Final review only.",
);

assert.equal(
  extractLocalAgentResponseText({
    messages: [
      { type: "assistant", text: "Earlier draft." },
      {
        type: "tool_call",
        name: "bash",
        arguments: { command: "npm test" },
      },
      {
        type: "tool_result",
        content: "full command output",
      },
      { type: "result", result: "Final answer." },
    ],
  }),
  "Final answer.",
);

assert.equal(
  extractLocalAgentResponseText({
    parts: [
      { type: "text", text: "Visible final text." },
      { type: "tool_use", name: "read", input: { path: "src/foo.ts" } },
      { tool_call_id: "call_1", content: "hidden tool result" },
    ],
  }),
  "Visible final text.",
);

assert.equal(
  extractLocalAgentResponseText({
    type: "tool_call",
    name: "bash",
    arguments: { command: "cat src/secret.ts" },
  }),
  "",
);

assert.equal(
  extractLocalAgentResponseText({
    unexpected: { nested: "raw provider event" },
  }),
  "",
);
