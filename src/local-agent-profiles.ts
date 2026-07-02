import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ServerConfig } from "./config.js";

export type AgentPermissionValue = "allow" | "ask" | "deny";
export type LocalAgentProfileBackend = "auto" | "codex-sdk" | "cli" | "acp";

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: string;
  backend?: LocalAgentProfileBackend;
  command?: string;
  model?: string;
  mode?: string;
  permissions?: Record<string, AgentPermissionValue>;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: string;
  model?: string;
  mode?: string;
  permissions?: Record<string, AgentPermissionValue>;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";
const PERMISSION_VALUES = new Set<AgentPermissionValue>(["allow", "ask", "deny"]);
const BACKENDS = new Set<LocalAgentProfileBackend>(["auto", "codex-sdk", "cli", "acp"]);

export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
): Promise<LocalAgentProfile[]> {
  if (!config.localAgents) return [];

  const profileDirs = [
    config.devspaceAgentsDir,
    join(workspaceRoot, ".devspace", "agents"),
  ];
  const profilesByName = new Map<string, LocalAgentProfile>();

  for (const directory of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeLocalAgentProfile(
  profile: LocalAgentProfile,
): LocalAgentProfileSummary {
  return {
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    mode: profile.mode,
    permissions: profile.permissions,
  };
}

async function loadProfilesFromDirectory(directory: string): Promise<LocalAgentProfile[]> {
  const resolvedDirectory = resolve(directory);
  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: LocalAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);
    profiles.push(await loadProfileFile(filePath));
  }

  return profiles;
}

async function loadProfileFile(filePath: string): Promise<LocalAgentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);
  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Local agent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (endIndex === -1) {
    throw new Error(`Local agent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseSimpleYaml(lines.slice(1, endIndex), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseSimpleYaml(lines: string[], filePath: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentMapKey: string | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const nestedMatch = /^  ([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (nestedMatch) {
      if (!currentMapKey) {
        throw new Error(`Unexpected nested frontmatter field in ${filePath}: ${rawLine}`);
      }
      const current = result[currentMapKey];
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error(`Invalid nested frontmatter field in ${filePath}: ${rawLine}`);
      }
      (current as Record<string, unknown>)[nestedMatch[1] ?? ""] = parseScalar(nestedMatch[2] ?? "");
      continue;
    }

    const topLevelMatch = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!topLevelMatch) {
      throw new Error(`Unsupported frontmatter line in ${filePath}: ${rawLine}`);
    }

    const key = topLevelMatch[1] ?? "";
    const value = topLevelMatch[2] ?? "";
    if (value === "") {
      result[key] = {};
      currentMapKey = key;
      continue;
    }

    result[key] = parseScalar(value);
    currentMapKey = undefined;
  }

  return result;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function profileFromFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
  filePath: string,
): LocalAgentProfile {
  const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
  const description = readString(frontmatter, "description");
  const provider = readString(frontmatter, "provider");
  if (!description) {
    throw new Error(`Local agent profile is missing description: ${filePath}`);
  }
  if (!provider) {
    throw new Error(`Local agent profile is missing provider: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    backend: readBackend(frontmatter, filePath),
    command: readString(frontmatter, "command"),
    model: readString(frontmatter, "model"),
    mode: readString(frontmatter, "mode"),
    permissions: readPermissions(frontmatter.permissions, filePath),
    filePath,
    body,
    disabled: frontmatter.disabled === true,
  };
}

function readBackend(
  frontmatter: Record<string, unknown>,
  filePath: string,
): LocalAgentProfileBackend | undefined {
  const backend = readString(frontmatter, "backend");
  if (!backend) return undefined;
  if (!BACKENDS.has(backend as LocalAgentProfileBackend)) {
    throw new Error(`Local agent profile backend must be auto, codex-sdk, cli, or acp: ${filePath}`);
  }
  return backend as LocalAgentProfileBackend;
}

function readString(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPermissions(
  value: unknown,
  filePath: string,
): Record<string, AgentPermissionValue> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local agent profile permissions must be a map: ${filePath}`);
  }

  const permissions: Record<string, AgentPermissionValue> = {};
  for (const [key, rawPermission] of Object.entries(value)) {
    if (!PERMISSION_VALUES.has(rawPermission as AgentPermissionValue)) {
      throw new Error(
        `Local agent profile permission '${key}' must be allow, ask, or deny: ${filePath}`,
      );
    }
    permissions[key] = rawPermission as AgentPermissionValue;
  }

  return Object.keys(permissions).length > 0 ? permissions : undefined;
}
