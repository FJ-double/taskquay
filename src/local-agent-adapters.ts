import { localAgentProviderEnvironment, type SubagentsConfig } from "./local-agent-config.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";
import { McpLocalAgentDriver } from "./local-agent-mcp.js";
import { ClaudeCliDriver } from "./local-agent-claude-cli.js";
export type LocalAgentAdapter = LocalAgentDriver;
export interface LocalAgentDriverOptions { env?: NodeJS.ProcessEnv; subagents?: SubagentsConfig }
export function createLocalAgentDrivers(options: LocalAgentDriverOptions = {}): LocalAgentDriver[] {
  const env = options.env ?? process.env;
  return [
    new McpLocalAgentDriver("codex", options.subagents ? localAgentProviderEnvironment(options.subagents, "codex", env) : env),
    new ClaudeCliDriver(options.subagents ? localAgentProviderEnvironment(options.subagents, "claude", env) : env),
  ];
}
