import { LOCAL_AGENT_PROVIDERS, type LocalAgentProvider } from "./local-agent-profiles.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { discoverHostAgents } from "./host-agents.js";
export interface LocalAgentProviderAvailability { name: LocalAgentProvider; available: boolean; reason?: string; note?: string }
export function getLocalAgentProviderAvailabilitySnapshot(env: NodeJS.ProcessEnv = process.env, config?: SubagentsConfig): LocalAgentProviderAvailability[] {
  const agents = discoverHostAgents(env, config);
  return LOCAL_AGENT_PROVIDERS.map(name => {
    const agent = agents.find(agent => agent.id === name);
    const selected = config?.providers.find(provider => provider.id === name);
    const explicitCommand = (selected && "command" in selected ? selected.command : undefined)
      ?? env[name === "codex" ? "CODEX_COMMAND" : name === "claude" ? "CLAUDE_COMMAND" : ""];
    return { name, available: agent?.installed === true,
      ...(!agent?.installed ? { reason: explicitCommand ? `${explicitCommand} executable not found` : agent?.install ?? "Install the provider CLI." }
        : { note: name === "claude" ? "Installed Claude CLI via restricted print mode" : "Installed Codex CLI via MCP stdio" }) };
  });
}
export function assertLocalAgentProviderAvailable(provider: LocalAgentProvider, env = process.env, config?: SubagentsConfig): void {
  const entry = getLocalAgentProviderAvailabilitySnapshot(env, config).find(entry => entry.name === provider)!;
  if (!entry.available) throw new Error(entry.reason ?? `${provider} CLI unavailable.`);
}
