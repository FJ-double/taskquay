import type { McpRegistrationTarget } from "./mcp-modern-server.js";

export interface ToolCapabilities { windowsDesktop: boolean; blender: boolean; hostAgent: boolean; artifacts: boolean }
interface Backend { listTools(): Promise<unknown[]>; close(): Promise<void> }
export async function backendAvailable(backend?: Backend): Promise<boolean> {
  if (!backend) return false;
  try { if ((await backend.listTools()).length > 0) return true; }
  catch { /* An optional unavailable backend is omitted from the surface. */ }
  await backend.close().catch(() => undefined);
  return false;
}
/** One registration policy governs discovery and dispatch; token filtering wraps this target. */
export function filterToolCapabilities(target: McpRegistrationTarget, capabilities: ToolCapabilities): McpRegistrationTarget {
  const optional: Record<string, boolean> = { windows_mcp: capabilities.windowsDesktop, blender_mcp: capabilities.blender,
    agent_mcp: capabilities.hostAgent, download_artifact: capabilities.artifacts };
  return {
    registerTool: ((...args: unknown[]) => {
      if (typeof args[0] === "string" && optional[args[0]] === false) return;
      return (target.registerTool as (...params: unknown[]) => unknown)(...args);
    }) as McpRegistrationTarget["registerTool"],
    registerResource: target.registerResource.bind(target),
  };
}
