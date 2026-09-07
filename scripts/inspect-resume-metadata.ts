/** Inspect one authorized terminal managed thread, without resuming or reading items. */
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { LocalAgentClient } from "../src/local-agent-client.js";
import { assertAllowedPath } from "../src/roots.js";
import { CodexAppServerRuntime, codexCommandEnvironment, resolveCodexCommand } from "../src/local-agent-codex.js";

const [agentId, workspaceId, root] = process.argv.slice(2);
if (!/^agt_[a-z0-9]+$/.test(agentId ?? "") || !/^ws_[a-z0-9]+$/.test(workspaceId ?? "") || !root) throw new Error("Provide scoped agent, workspace and authorized root.");
const config = loadConfig();
const workspaceRoot = assertAllowedPath(root, config.allowedRoots);
const client = new LocalAgentClient({ stateDir: config.stateDir, configDir: config.configDir });
const found = await client.get(agentId!, { workspaceId, workspaceRoot });
if (found.isErr() || !found.value.providerSessionId || ["queued", "starting", "running"].includes(found.value.status)) throw new Error("A terminal scoped thread is required.");
const threadId = found.value.providerSessionId;
const env = codexCommandEnvironment();
const command = resolveCodexCommand(env);
if (!command) throw new Error("Configured provider unavailable.");
const runtime = new CodexAppServerRuntime({ command: command.executable, env, version: command.version });
try {
  await runtime.initialize();
  const value = await runtime.control("thread/read", { threadId, includeTurns: false }) as {
    thread?: { id?: string; cwd?: string; ephemeral?: boolean; archived?: boolean; status?: { type?: string }; historyMode?: string; modelProvider?: string };
  };
  const thread = value.thread;
  if (thread?.id !== threadId) throw new Error("Returned identity differs.");
  console.log(JSON.stringify({ agentId, threadId, version: command.version, cwdMatches: thread.cwd?.replaceAll("\\", "/").toLowerCase() === workspaceRoot.replaceAll("\\", "/").toLowerCase(),
    status: thread.status?.type, ephemeral: thread.ephemeral, archived: thread.archived, historyMode: thread.historyMode,
    providerInvoked: false, resumed: false, conversationItemsRead: false }));
} catch (error) {
  const chain: { type: string; code?: string | number; fingerprint: string; flags: string[] }[] = [];
  for (let e: unknown = error; e && chain.length < 4; e = (e as { cause?: unknown }).cause) {
    const obj = e as { message?: string; name?: string; code?: string | number };
    const message = typeof obj.message === "string" ? obj.message : "";
    const flags = ["paginated", "experimentalApi", "rollout", "not found", "archived", "unsupported", "invalid", "permission", "sandbox", "configuration", "deserialize", "thread busy", "in progress"].filter((s) => message.toLowerCase().includes(s.toLowerCase()));
    chain.push({ type: /^[A-Za-z]{1,60}$/.test(obj.name ?? "") ? obj.name! : "Error", code: typeof obj.code === "number" || /^[A-Z_]{1,60}$/.test(String(obj.code ?? "")) ? obj.code : undefined,
      fingerprint: createHash("sha256").update(message).digest("hex").slice(0,20), flags });
  }
  console.log(JSON.stringify({ agentId, threadId, metadataRead: false, providerInvoked: false, chain }));
  process.exitCode = 1;
} finally { await runtime.close(); }
