import assert from "node:assert/strict";
import { createLocalAgentAdapter } from "./local-agent-adapters.js";
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
