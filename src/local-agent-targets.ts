import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProfile,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

export interface ParsedLocalAgentRunArgs {
  target: string;
  prompt: string;
  model?: string;
  effort?: string;
}

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProvider;
      provider: LocalAgentProvider;
      model?: string;
      effort?: string;
    };

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] "<prompt>"',
  );
  return parsed;
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const parsed = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] "<prompt>"',
  );
  return { agentId: parsed.target, prompt: parsed.prompt, model: parsed.model, effort: parsed.effort };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;
  if (!target) {
    throw new Error(usage);
  }

  let model: string | undefined;
  let effort: string | undefined;
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded) {
      promptParts.push(part ?? "");
      continue;
    }
    if (part === "--model") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--model=")) {
      const value = part.slice("--model=".length).trim();
      if (!value) throw new Error("Missing value for --model.");
      model = value;
      continue;
    }
    if (part === "--effort") {
      const value = rest[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --effort.");
      effort = value;
      index += 1;
      continue;
    }
    if (part?.startsWith("--effort=")) {
      const value = part.slice("--effort=".length).trim();
      if (!value) throw new Error("Missing value for --effort.");
      effort = value;
      continue;
    }
    if (part?.startsWith("-")) {
      throw new Error(`Unknown option: ${part}. Use -- before prompt text that starts with a dash.`);
    }
    promptParts.push(part ?? "");
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    throw new Error(usage);
  }

  return { target, prompt, model, effort };
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);
  if (profile) {
    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model,
      effort: effortOverride ?? profile.effort,
      profile,
    };
  }

  if (isLocalAgentProvider(target)) {
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride,
      effort: effortOverride,
    };
  }

  return undefined;
}

export function formatAvailableLocalAgentTargets(profiles: LocalAgentProfile[]): string {
  const profileNames = profiles.map((profile) => profile.name);
  const parts = [
    profileNames.length > 0 ? `profiles: ${profileNames.join(", ")}` : undefined,
    `providers: ${LOCAL_AGENT_PROVIDERS.join(", ")}`,
  ].filter(Boolean);
  return parts.join("; ");
}
