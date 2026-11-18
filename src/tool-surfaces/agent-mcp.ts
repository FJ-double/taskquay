import { stat } from "node:fs/promises";
import * as z from "zod/v4";
import { parseSafeWindowsArtifactRelativePath } from "../artifact-path-windows.js";
import type { HostAgentBridge } from "../host-agents.js";
import { textBlock } from "./shared.js";
import type { ToolRegistrationContext } from "./types.js";

const readArguments = z.strictObject({
  file_path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});

export async function hasAgentMcpRead(bridge: HostAgentBridge): Promise<boolean> {
  return bridge.agent.id === "claude" && (await bridge.listTools()).some(tool => tool.name === "Read");
}

export function registerAgentMcp({ server, workspaces, processSessions }: ToolRegistrationContext, bridge: HostAgentBridge): void {
  server.registerTool("agent_mcp", {
    title: "Read a workspace file through Claude CLI",
    description: "List agent tools permitted by Taskquay, or call Read with a workspace_id and a workspace-relative file_path. Other coding operations use Taskquay's workspace tools or agent_task.",
    inputSchema: {
      action: z.enum(["list_tools", "call"]),
      workspace_id: z.string().optional(),
      tool: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ action, workspace_id, tool, arguments: args }) => {
    if (action === "list_tools") {
      const tools = await hasAgentMcpRead(bridge) ? [{
        name: "Read",
        description: "Read a regular file relative to the selected Taskquay workspace.",
        inputSchema: z.toJSONSchema(readArguments),
      }] : [];
      return { content: [textBlock(JSON.stringify(tools))] };
    }

    if (bridge.agent.id !== "claude" || tool !== "Read") throw new Error("Agent MCP tool is not permitted.");
    if (!workspace_id) throw new Error("agent_mcp Read requires workspace_id.");
    const { file_path, offset, limit } = readArguments.parse(args);
    const path = parseSafeWindowsArtifactRelativePath(file_path);
    if (!path) throw new Error("agent_mcp Read requires a safe workspace-relative file path.");

    const workspace = await workspaces.getWorkspace(workspace_id);
    return processSessions.readWorkspace(workspace.root, async () => {
      const file = await workspaces.resolvePath(workspace, path.path);
      if (!(await stat(file)).isFile()) throw new Error("agent_mcp Read requires a regular file.");
      return bridge.callTool("Read", { file_path: file, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
    });
  });
}
