import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ServerConfig } from "./config.js";

export type LocalAgentStatus = "starting" | "running" | "idle" | "error" | "stopped";

export interface LocalAgentRecord {
  id: string;
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
  providerSessionId?: string;
  status: LocalAgentStatus;
  latestResponse?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalAgentRecordInput {
  workspaceId?: string;
  workspaceRoot: string;
  profileName: string;
  provider: string;
  model?: string;
}

interface LocalAgentStoreData {
  agents: LocalAgentRecord[];
}

export interface LocalAgentListScope {
  workspaceId?: string;
  workspaceRoot?: string;
}

export class LocalAgentStore {
  constructor(private readonly filePath: string) {}

  list(scope: LocalAgentListScope = {}): LocalAgentRecord[] {
    const data = this.read();
    const resolvedRoot = scope.workspaceRoot ? resolve(scope.workspaceRoot) : undefined;
    return data.agents
      .filter((agent) => {
        if (scope.workspaceId) return agent.workspaceId === scope.workspaceId;
        return !resolvedRoot || resolve(agent.workspaceRoot) === resolvedRoot;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(input: CreateLocalAgentRecordInput): LocalAgentRecord {
    const now = new Date().toISOString();
    const record: LocalAgentRecord = {
      id: `agt_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      workspaceId: input.workspaceId,
      workspaceRoot: resolve(input.workspaceRoot),
      profileName: input.profileName,
      provider: input.provider,
      model: input.model,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    this.write((data) => ({ agents: [...data.agents, record] }));
    return record;
  }

  get(idOrPrefix: string): LocalAgentRecord | undefined {
    const agents = this.read().agents;
    return resolveRecord(idOrPrefix, agents);
  }

  update(id: string, patch: Partial<Omit<LocalAgentRecord, "id" | "createdAt">>): LocalAgentRecord {
    let updated: LocalAgentRecord | undefined;
    this.write((data) => ({
      agents: data.agents.map((agent) => {
        if (agent.id !== id) return agent;
        updated = {
          ...agent,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        return updated;
      }),
    }));

    if (!updated) throw new Error(`Unknown subagent id: ${id}`);
    return updated;
  }

  private read(): LocalAgentStoreData {
    if (!existsSync(this.filePath)) return { agents: [] };
    return normalizeStoreData(JSON.parse(readFileSync(this.filePath, "utf8")));
  }

  private write(update: (data: LocalAgentStoreData) => LocalAgentStoreData): void {
    const next = update(this.read());
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }
}

export function createLocalAgentStore(config: ServerConfig): LocalAgentStore {
  return new LocalAgentStore(join(config.stateDir, "local-agents.json"));
}

function normalizeStoreData(value: unknown): LocalAgentStoreData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { agents: [] };
  const agents = (value as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return { agents: [] };
  return {
    agents: agents.filter(isLocalAgentRecord),
  };
}

function isLocalAgentRecord(value: unknown): value is LocalAgentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<LocalAgentRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.profileName === "string" &&
    typeof record.provider === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function resolveRecord(
  idOrPrefix: string,
  agents: LocalAgentRecord[],
): LocalAgentRecord | undefined {
  const exact = agents.find((agent) => agent.id === idOrPrefix || agent.providerSessionId === idOrPrefix);
  if (exact) return exact;

  const matches = agents.filter(
    (agent) =>
      agent.id.startsWith(idOrPrefix) ||
      (agent.providerSessionId?.startsWith(idOrPrefix) ?? false),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
