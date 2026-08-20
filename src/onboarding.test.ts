import assert from "node:assert/strict";
import {
  SUBAGENT_SKILL_INSTALL_COMMAND,
  updateOnboardingSubagentsConfig,
} from "./onboarding.js";

assert.deepEqual(
  updateOnboardingSubagentsConfig(
    { enabled: false, providers: [] },
    true,
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
  updateOnboardingSubagentsConfig(configured, true, ["claude"]),
  {
    enabled: true,
    providers: [
      { id: "codex", enabled: false, model: "gpt-5.4", effort: "high" },
      { id: "claude", enabled: true, model: "sonnet" },
    ],
  },
);
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, false, []),
  { ...configured, enabled: false },
);
assert.equal(
  SUBAGENT_SKILL_INSTALL_COMMAND,
  "npx skills add Waishnav/devspace --skill subagent-delegation --global",
);
