import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BlenderMcpConfig } from "./config.js";

export class BlenderMcpBridge {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;

  constructor(private readonly config: BlenderMcpConfig) {}

  async listTools(): Promise<Tool[]> {
    const client = await this.ensureClient();
    const result = await client.listTools();
    if (this.config.allowedTools.includes("*")) return result.tools;
    const allowed = new Set(this.config.allowedTools);
    return result.tools.filter((tool) => allowed.has(tool.name));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (!this.config.allowedTools.includes("*") && !this.config.allowedTools.includes(name)) {
      throw new Error(`Blender MCP tool is not allowed through TaskQuay: ${name}`);
    }
    const client = await this.ensureClient();
    const result = await client.callTool({ name, arguments: args });
    if ("content" in result && Array.isArray(result.content)) {
      return result as CallToolResult;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    if (client) await client.close();
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return await this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<Client> {
    if (!this.config.command.trim()) {
      throw new Error("Blender MCP is enabled but no command is configured.");
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      stderr: "pipe",
    });
    const client = new Client({ name: "taskquay-blender-mcp-bridge", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    this.transport = transport;
    this.client = client;
    return client;
  }
}
