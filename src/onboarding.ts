import {
  localAgentProviderEnvironment,
  providerCommandVariable,
  type SubagentsConfig,
} from "./local-agent-config.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export const SUBAGENT_SKILL_INSTALL_COMMAND =
  "npx skills add Waishnav/devspace --skill subagents --global";

export const ONBOARDING_DESTINATIONS = ["chatgpt", "coding-agents"] as const;
export type OnboardingDestination = typeof ONBOARDING_DESTINATIONS[number];
export type OnboardingUsage = OnboardingDestination | "both";

export function resolveOnboardingUsage(
  destinations: readonly OnboardingDestination[],
): OnboardingUsage {
  const selected = new Set(destinations);
  if (selected.has("chatgpt") && selected.has("coding-agents")) return "both";
  if (selected.has("chatgpt")) return "chatgpt";
  if (selected.has("coding-agents")) return "coding-agents";
  throw new Error("Choose ChatGPT, Coding Agents, or both.");
}

export function usesChatGpt(usage: OnboardingUsage): boolean {
  return usage === "chatgpt" || usage === "both";
}

export function usesCodingAgents(usage: OnboardingUsage): boolean {
  return usage === "coding-agents" || usage === "both";
}

export function updateOnboardingSubagentsConfig(
  current: SubagentsConfig,
  selectedProviders: readonly LocalAgentProvider[],
): SubagentsConfig {
  const selected = new Set(selectedProviders);
  return {
    enabled: true,
    instructions: current.instructions,
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

/** Pin selected local CLI paths so the background service doesn't depend on the installer's PATH. */
export function bindOnboardingAgentCommands(
  subagents: SubagentsConfig,
  inherited: NodeJS.ProcessEnv = process.env,
): SubagentsConfig {
  return {
    ...subagents,
    providers: subagents.providers.map((provider) => {
      if (!provider.enabled) return provider;
      const variable = providerCommandVariable(provider.id);
      if (!variable || ("command" in provider && provider.command)) return provider;
      const env = localAgentProviderEnvironment(subagents, provider.id, inherited);
      const fallback = provider.id === "cursor" ? "cursor-agent" : provider.id;
      const executable = resolveExecutableCommand(env[variable] ?? fallback, env);
      return executable ? { ...provider, command: executable } : provider;
    }),
  };
}
