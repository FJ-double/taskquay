import type { SubagentsConfig } from "./local-agent-config.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add Waishnav/devspace --skill subagent-delegation --global";

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  enabled: boolean,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  if (!enabled) return { ...current, enabled: false };

  const selected = new Set(selectedProviders);
  return {
    enabled: true,
    providers: LOCAL_AGENT_PROVIDERS
      .filter((id) => selected.has(id) || current.providers.some((provider) => provider.id === id))
      .map((id) => {
        const existing = current.providers.find((provider) => provider.id === id);
        return {
          ...existing,
          id,
          enabled: selected.has(id),
        };
      }),
  };
}
