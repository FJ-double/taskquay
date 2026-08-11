import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
}

export interface LocalAgentRunResult {
  provider: string;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  provider: LocalAgentProvider;
  workspace: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  thinking?: string;
  agentDir?: string;
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

export interface LocalAgentDriver {
  readonly provider: LocalAgentProvider;
  runtimeKey(context: LocalAgentRuntimeContext): string;
  createRuntime(context: LocalAgentRuntimeContext): Promise<LocalAgentRuntime>;
  readonly idleTimeoutMs?: number;
}
