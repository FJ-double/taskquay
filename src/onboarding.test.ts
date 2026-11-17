import assert from "node:assert/strict";
import {
  bindOnboardingAgentCommands,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
} from "./onboarding.js";

for (const [selections, expected] of [
  [["chatgpt"], "chatgpt"],
  [["coding-agents"], "coding-agents"],
  [["coding-agents", "chatgpt"], "both"],
] as const) {
  assert.equal(resolveOnboardingUsage(selections), expected);
}
assert.throws(() => resolveOnboardingUsage([]), /Choose ChatGPT, Coding Agents, or both/);

assert.deepEqual(
  updateOnboardingSubagentsConfig(
    { enabled: false, instructions: "on-demand", providers: [] },
    ["codex", "claude"],
  ),
  {
    enabled: true,
    instructions: "on-demand",
    providers: [
      { id: "codex", enabled: true },
      { id: "claude", enabled: true },
    ],
  },
);

const configured = {
  enabled: true,
  instructions: "preload" as const,
  providers: [
    {
      id: "codex" as const,
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude" as const, enabled: true, model: "sonnet" },
  ],
};
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, ["claude"]),
  {
    enabled: true,
    instructions: "preload",
    providers: [
      {
        id: "codex",
        enabled: false,
        model: "gpt-5.4",
        effort: "high",
        command: "/opt/bin/codex-wrapper",
        env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
      },
      { id: "claude", enabled: true, model: "sonnet" },
    ],
  },
);

assert.deepEqual(
  bindOnboardingAgentCommands({
    enabled: true,
    instructions: "on-demand",
    providers: [
      { id: "claude", enabled: true },
      { id: "codex", enabled: false },
    ],
  }, { PATH: "", CLAUDE_COMMAND: process.execPath, CODEX_COMMAND: process.execPath }).providers,
  [
    { id: "claude", enabled: true, command: process.execPath },
    { id: "codex", enabled: false },
  ],
  "initialization pins only selected installed local Agent paths",
);
assert.deepEqual(
  bindOnboardingAgentCommands({
    enabled: true,
    instructions: "on-demand",
    providers: [{ id: "claude", enabled: true, command: "/custom/claude" }],
  }, { PATH: "", CLAUDE_COMMAND: process.execPath }).providers[0],
  { id: "claude", enabled: true, command: "/custom/claude" },
  "an explicitly selected Agent executable must not be overwritten",
);

for (const [id, variable] of [["opencode", "OPENCODE_COMMAND"], ["pi", "PI_COMMAND"]] as const) {
  const selected = bindOnboardingAgentCommands(updateOnboardingSubagentsConfig({
    enabled: false, instructions: "on-demand", providers: [],
  }, [id]), { PATH: "", [variable]: process.execPath });
  assert.deepEqual(selected.providers, [{ id, enabled: true, command: process.execPath }]);
}
