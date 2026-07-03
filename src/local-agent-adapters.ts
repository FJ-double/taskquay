import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import {
  createCodexSdkLocalAgentRuntime,
  type LocalAgentRunInput,
  type LocalAgentRunResult,
} from "./local-agent-runtime.js";

export interface LocalAgentAdapter {
  readonly provider: LocalAgentProvider;
  run(input: LocalAgentRunInput): Promise<LocalAgentRunResult>;
}

const ACP_COMMANDS: Record<"cursor" | "copilot", [string, ...string[]]> = {
  cursor: ["cursor-agent", "--acp"],
  copilot: ["copilot", "--acp"],
};

export async function runLocalAgentProvider(
  provider: LocalAgentProvider,
  input: LocalAgentRunInput,
): Promise<LocalAgentRunResult> {
  return createLocalAgentAdapter(provider).run(input);
}

export function createLocalAgentAdapter(provider: LocalAgentProvider): LocalAgentAdapter {
  switch (provider) {
    case "codex":
      return new CodexLocalAgentAdapter();
    case "claude":
      return new ClaudeLocalAgentAdapter();
    case "opencode":
      return new OpencodeLocalAgentAdapter();
    case "pi":
      return new PiRpcLocalAgentAdapter();
    case "cursor":
    case "copilot":
      return new AcpLocalAgentAdapter(provider, ACP_COMMANDS[provider]);
  }
}

class CodexLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "codex" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const runtime = await createCodexSdkLocalAgentRuntime();
    return runtime.run(input);
  }
}

class ClaudeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "claude" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const messages = query({
      prompt: input.prompt,
      options: {
        cwd: input.workspace,
        model: input.model,
        resume: input.providerSessionId,
        permissionMode: "plan",
        maxTurns: 1,
      },
    });

    let providerSessionId = input.providerSessionId ?? null;
    let finalResponse = "";
    const items: unknown[] = [];
    for await (const message of messages) {
      items.push(message);
      const record = message as Record<string, unknown>;
      if (typeof record.session_id === "string") providerSessionId = record.session_id;
      if (record.type === "result" && typeof record.result === "string") {
        finalResponse = record.result;
      }
    }

    return {
      provider: this.provider,
      providerSessionId,
      finalResponse: finalResponse.trim(),
      items,
    };
  }
}

class OpencodeLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "opencode" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { createOpencode } = await import("@opencode-ai/sdk/v2");
    const { client, server } = await createOpencode();
    try {
      const sessionId = input.providerSessionId ?? await createOpencodeSession(client, input);
      const promptResult = await client.session.prompt({
        sessionID: sessionId,
        directory: input.workspace,
        ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
        parts: [{ type: "text", text: input.prompt }],
      }, { throwOnError: true });
      const finalResponse = extractText(promptResult);
      return {
        provider: this.provider,
        providerSessionId: sessionId,
        finalResponse,
        items: [promptResult],
      };
    } finally {
      server.close();
    }
  }
}

class AcpLocalAgentAdapter implements LocalAgentAdapter {
  constructor(
    readonly provider: "cursor" | "copilot",
    private readonly command: [string, ...string[]],
  ) {}

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const { client } = await import("@agentclientprotocol/sdk");
    const { ndJsonStream } = await import("@agentclientprotocol/sdk");
    const [command, ...args] = this.command;
    const child = spawn(command, args, {
      cwd: input.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    try {
      let providerSessionId = input.providerSessionId ?? null;
      const finalResponse = await client({ name: "DevSpace" }).connectWith(stream, async (context) => {
        const session = await context.buildSession(input.workspace).start();
        providerSessionId = session.sessionId;
        try {
          await session.prompt(input.prompt);
          return await session.readText();
        } finally {
          session.dispose();
        }
      });
      return {
        provider: this.provider,
        providerSessionId,
        finalResponse: finalResponse.trim(),
        items: [],
      };
    } catch (error) {
      throw new Error(`${this.provider} ACP run failed: ${errorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`);
    } finally {
      child.kill();
    }
  }
}

class PiRpcLocalAgentAdapter implements LocalAgentAdapter {
  readonly provider = "pi" as const;

  async run(input: LocalAgentRunInput): Promise<LocalAgentRunResult> {
    const child = spawn(process.env.PI_COMMAND ?? "pi", ["--mode", "rpc"], {
      cwd: input.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assertPipedChild(child);
    const rpc = new JsonLineRpc(child);
    try {
      await rpc.request({
        type: "prompt",
        message: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.providerSessionId ? { session: input.providerSessionId } : {}),
      });
      const messages = await rpc.request({ type: "get_messages" });
      return {
        provider: this.provider,
        providerSessionId: input.providerSessionId ?? null,
        finalResponse: extractText(messages),
        items: [messages],
      };
    } finally {
      child.kill();
    }
  }
}

class JsonLineRpc {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = "";
  private nextId = 1;
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderr}`.trim()));
    });
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    const id = `req_${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(extractText(message.error)));
      } else {
        pending.resolve(message.result ?? message);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function createOpencodeSession(client: unknown, input: LocalAgentRunInput): Promise<string> {
  const result = await (client as {
    session: {
      create(parameters?: unknown, options?: unknown): Promise<unknown>;
    };
  }).session.create({
    directory: input.workspace,
    ...(input.model ? { model: parseOpencodeModel(input.model) } : {}),
  }, { throwOnError: true });
  const id = (result as { id?: unknown }).id;
  if (typeof id !== "string") {
    throw new Error("OpenCode did not return a session id.");
  }
  return id;
}

function parseOpencodeModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator === -1) return { providerID: "opencode", modelID: model };
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractText(value);
}

function assertPipedChild(child: ReturnType<typeof spawn>): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Agent process did not expose stdio pipes.");
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n").trim();
  }
  const record = value as Record<string, unknown>;
  if (isToolLikeRecord(record)) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.result === "string") return record.result;
  if (Array.isArray(record.parts)) return extractText(record.parts);
  if (Array.isArray(record.messages)) return extractText(lastAssistantLikeMessage(record.messages));
  if (Array.isArray(record.data)) return extractText(record.data);
  return "";
}

function lastAssistantLikeMessage(messages: unknown[]): unknown {
  const candidates = messages.filter((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return true;
    const record = message as Record<string, unknown>;
    if (isToolLikeRecord(record)) return false;
    const role = typeof record.role === "string" ? record.role : "";
    if (role) return role === "assistant";
    const type = typeof record.type === "string" ? record.type : "";
    return !type || type === "assistant" || type === "message" || type === "result";
  });
  return candidates.at(-1);
}

function isToolLikeRecord(record: Record<string, unknown>): boolean {
  const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
  if (role === "tool" || role === "function") return true;

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.includes("tool") || type.includes("function_call")) return true;

  return (
    "toolCallId" in record ||
    "tool_call_id" in record ||
    "toolCalls" in record ||
    "tool_calls" in record ||
    "functionCall" in record ||
    "function_call" in record
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
