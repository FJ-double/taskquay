import { randomUUID } from "node:crypto";
import { HostAgentBridge, discoverHostAgents, type HostAgentId } from "./host-agents.js";
import { captureAgentProviderResult } from "./local-agent-errors.js";
import type { LocalAgentDriver, LocalAgentRuntime, LocalAgentRuntimeContext } from "./local-agent-runtime.js";

/** Agent execution stays in the user's CLI process; Taskquay only speaks MCP. */
export class McpLocalAgentDriver implements LocalAgentDriver {
  constructor(readonly provider: HostAgentId, private readonly env: NodeJS.ProcessEnv = process.env) {}
  runtimeKey(context: LocalAgentRuntimeContext): string { return `${this.provider}:mcp:${context.workspaceRoot}`; }
  createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({ provider: this.provider, operation: "create_runtime", run: async (): Promise<LocalAgentRuntime> => {
      const agent = discoverHostAgents(this.env).find(agent => agent.id === this.provider)!;
      if (!agent.installed) throw new Error(`${agent.id} CLI not installed. ${agent.install}`);
      const bridge = new HostAgentBridge(agent, this.env, context.workspaceRoot);
      const tools = await bridge.listTools();
      let alive = true;
      const modes = new Map<string, string>();
      return {
        provider: this.provider, isAlive: () => alive,
        close: async () => { alive = false; await bridge.close(); }, releaseSession: async () => undefined,
        run: (input, callbacks) => captureAgentProviderResult({ provider: this.provider, operation: "run", run: async () => {
          // Codex MCP owns its sandbox. Other MCP servers must advertise an agent tool
          // with an enforceable read-only mode before they can accept agent_task.
          if (this.provider !== "codex") {
            callbacks?.onNotRequested?.();
            throw new Error("This CLI exposes direct MCP tools through agent_mcp. agent_task requires the Codex CLI MCP agent capability.");
          }
          const resume = Boolean(input.providerSessionId);
          if (resume && modes.get(input.providerSessionId!) !== (input.writeMode ?? "allowed")) {
            callbacks?.onNotRequested?.();
            throw new Error("This MCP session cannot prove the requested permission mode. Start a new task instead of resuming with different or unknown authority.");
          }
          const name = resume ? "codex-reply" : "codex";
          if (!tools.some(tool => tool.name === name)) { callbacks?.onNotRequested?.(); throw new Error(`Selected CLI lacks MCP capability ${name}.`); }
          const args = resume ? { threadId: input.providerSessionId, prompt: input.prompt } : {
            prompt: input.prompt, cwd: input.workspaceRoot, "approval-policy": "never",
            sandbox: input.writeMode === "read_only" ? "read-only" : input.writeMode === "full_access" ? "danger-full-access" : "workspace-write",
            ...(input.model ? { model: input.model } : {}), ...(input.profileInstructions ? { "base-instructions": input.profileInstructions } : {}),
            ...(input.effort ? { config: { model_reasoning_effort: input.effort } } : {}),
          };
          await callbacks?.onRequest?.();
          await callbacks?.onTurnStarted?.(randomUUID());
          const result = await bridge.callTool(name, args);
          callbacks?.onProviderFinished?.();
          if (result.isError) throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n"));
          const structured = result.structuredContent as Record<string, unknown> | undefined;
          const sessionId = typeof structured?.threadId === "string" ? structured.threadId : input.providerSessionId ?? null;
          if (sessionId) { modes.set(sessionId, input.writeMode ?? "allowed"); await callbacks?.onSessionId?.(sessionId); }
          return { provider: this.provider, providerSessionId: sessionId,
            finalResponse: result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), items: [result] };
        } }),
      };
    } });
  }
}
