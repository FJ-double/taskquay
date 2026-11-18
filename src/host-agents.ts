import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import { localAgentProviderEnvironment, type SubagentsConfig } from "./local-agent-config.js";

export const HOST_AGENT_SPECS = [
  { id: "codex", args: ["mcp-server"], install: "Install Codex CLI: https://developers.openai.com/codex/cli/" },
  { id: "claude", args: ["mcp", "serve"], install: "Install Claude Code: https://code.claude.com/docs/en/setup" },
] as const;
export type HostAgentId = typeof HOST_AGENT_SPECS[number]["id"];
export interface HostAgent { id: HostAgentId; command?: string; args: string[]; installed: boolean; install: string }

/** Inspect installed CLIs only; never install a runtime or attach to an existing process. */
export function discoverHostAgents(env: NodeJS.ProcessEnv = process.env, config?: SubagentsConfig): HostAgent[] {
  return HOST_AGENT_SPECS.map(spec => {
    const providerEnv = config ? localAgentProviderEnvironment(config, spec.id, env) : env;
    const override = providerEnv[spec.id === "codex" ? "CODEX_COMMAND" : "CLAUDE_COMMAND"];
    const home = providerEnv.USERPROFILE ?? "";
    const candidates = override ? [override] : [spec.id,
      join(home, ".local", "bin", `${spec.id}.exe`),
      join(providerEnv.APPDATA ?? "", "npm", `${spec.id}.cmd`),
      join(providerEnv.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", `${spec.id}.exe`)];
    let command = candidates.map(value => resolveExecutableCommand(value, providerEnv)).find(Boolean);
    if (!command && !override) {
      const located = spawnSync("where.exe", [spec.id + ".exe"], { env: providerEnv, encoding: "utf8", timeout: 3000, windowsHide: true });
      if (located.status === 0) command = located.stdout.trim().split(/\r?\n/).find(candidate => {
        const version = spawnSync(candidate, ["--version"], { env: providerEnv, encoding: "utf8", timeout: 5000, windowsHide: true });
        return version.status === 0;
      });
    }
    return { ...spec, args: [...spec.args], command, installed: Boolean(command) };
  });
}

export function selectedHostAgent(config: SubagentsConfig, env = process.env): HostAgent | undefined {
  if (!config.enabled) return undefined;
  return discoverHostAgents(env, config).find(agent => agent.installed && config.providers.some(p => p.id === agent.id && p.enabled));
}

export class HostAgentBridge {
  private client?: Client;
  private connecting?: Promise<Client>;
  private tools?: Tool[];
  constructor(readonly agent: HostAgent, private readonly env: NodeJS.ProcessEnv = process.env, private readonly cwd?: string) {}

  async listTools(): Promise<Tool[]> {
    const client = await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do { const page = await client.listTools(cursor ? { cursor } : undefined); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    this.tools = tools;
    return tools;
  }
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const tools = this.tools ?? await this.listTools();
    if (!tools.some(tool => tool.name === name)) throw new Error(`Agent does not expose MCP tool: ${name}`);
    const result = await (await this.connect()).callTool({ name, arguments: args }, undefined, { timeout: 60 * 60_000 });
    if (!Array.isArray(result.content)) throw new Error("Agent returned an unsupported MCP response.");
    return result as CallToolResult;
  }
  async close(): Promise<void> { const client = this.client; this.client = undefined; this.tools = undefined; if (client) await client.close(); }
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<Client> {
    if (!this.agent.command) throw new Error(`${this.agent.id} CLI is missing. ${this.agent.install}`);
    const transport = new StdioClientTransport({ command: this.agent.command, args: this.agent.args,
      env: Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      ...(this.cwd ? { cwd: this.cwd } : {}), stderr: "pipe" });
    // Drain diagnostics; never forward CLI stderr (which can contain private data) to MCP output.
    transport.stderr?.on("data", () => undefined);
    const client = new Client({ name: "taskquay-host-agent", version: "1.1.1" });
    try { await client.connect(transport, { timeout: 15_000 }); }
    catch (error) { await transport.close().catch(() => undefined); throw error; }
    this.client = client;
    return client;
  }
}
