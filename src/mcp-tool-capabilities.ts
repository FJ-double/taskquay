import type { ServerConfig } from "./config.js";
import type { BlenderMcpBridge } from "./blender-mcp-bridge.js";
import type { WindowsMcpBridge } from "./windows-mcp-bridge.js";
import { filterMcpToolRegistrations, type McpRegistrationTarget } from "./mcp-modern-server.js";
import { logEvent } from "./logger.js";

export interface ToolAvailability {
  windowsDesktop: boolean;
  blender: boolean;
}

export async function resolveToolAvailability(
  config: ServerConfig,
  bridges: { windowsMcpBridge?: WindowsMcpBridge; blenderMcpBridge?: BlenderMcpBridge },
  platform: NodeJS.Platform = process.platform,
): Promise<ToolAvailability> {
  let blender = false;
  if (bridges.blenderMcpBridge) {
    try {
      await bridges.blenderMcpBridge.listTools();
      blender = true;
    } catch {
      await bridges.blenderMcpBridge.close().catch(() => undefined);
      logEvent(config.logging, "warn", "optional_tool_unavailable", { tool: "blender_mcp", reason: "backend_unreachable" });
    }
  }
  return { windowsDesktop: platform === "win32" && Boolean(bridges.windowsMcpBridge), blender };
}

/** Filter the registrations themselves, so discovery and calls share availability policy. */
export function filterToolAvailability(target: McpRegistrationTarget, available: ToolAvailability): McpRegistrationTarget {
  return filterMcpToolRegistrations(target, name => {
    if (name === "windows_mcp") return available.windowsDesktop;
    if (name === "blender_mcp") return available.blender;
    return true;
  });
}
