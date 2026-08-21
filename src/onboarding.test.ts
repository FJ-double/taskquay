import assert from "node:assert/strict";
import {
  resolveOnboardingUsage,
  SUBAGENT_SKILL_INSTALL_COMMAND,
  updateOnboardingSubagentsConfig,
  usesChatGpt,
  usesCodingAgents,
} from "./onboarding.js";

assert.equal(resolveOnboardingUsage(["chatgpt"]), "chatgpt");
assert.equal(resolveOnboardingUsage(["coding-agents"]), "coding-agents");
assert.equal(resolveOnboardingUsage(["coding-agents", "chatgpt"]), "both");
assert.equal(usesChatGpt("both"), true);
assert.equal(usesCodingAgents("both"), true);
assert.equal(usesChatGpt("coding-agents"), false);
assert.equal(usesCodingAgents("chatgpt"), false);
assert.throws(() => resolveOnboardingUsage([]), /Choose ChatGPT, Coding Agents, or both/);

assert.deepEqual(
  updateOnboardingSubagentsConfig(
    { enabled: false, providers: [] },
    ["codex", "claude"],
  ),
  {
    enabled: true,
    providers: [
      { id: "codex", enabled: true },
      { id: "claude", enabled: true },
    ],
  },
);

const configured = {
  enabled: true,
  providers: [
    { id: "codex" as const, enabled: true, model: "gpt-5.4", effort: "high" },
    { id: "claude" as const, enabled: true, model: "sonnet" },
  ],
};
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, ["claude"]),
  {
    enabled: true,
    providers: [
      { id: "codex", enabled: false, model: "gpt-5.4", effort: "high" },
      { id: "claude", enabled: true, model: "sonnet" },
    ],
  },
);
assert.equal(
  SUBAGENT_SKILL_INSTALL_COMMAND,
  "npx skills add Waishnav/devspace --skill subagents --global",
);
