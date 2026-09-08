/** Read-only identity diagnostics for an explicitly observed work-run suffix. No prose or provider/config contents. */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
const [path, suffix] = process.argv.slice(2);
if (!path || !/^[a-f0-9]{6}$/.test(suffix ?? "")) throw new Error("Provide explicit database path and observed six-hex run suffix.");
const hash = (value: unknown) => value === null || value === undefined ? null : createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
const db = new Database(path, { readonly: true, fileMustExist: true });
try {
  const result = db.transaction(() => {
    const runs = db.prepare("select id,project_id,workspace_id,created_at,finished_at from console_work_runs where substr(id,-6)=? limit 2").all(suffix) as Record<string, unknown>[];
    if (runs.length !== 1) throw new Error("Observed suffix does not identify exactly one run.");
    const run = runs[0]!;
    const rows = db.prepare(`select e.id as execution_id,e.created_at,e.finished_at,e.status,e.managed_thread_id,
      a.id as agent_id,a.provider_session_id,a.workspace_id,a.work_item_id,a.context_key,a.context_signature,
      a.status as agent_status,a.error_code,
      (select count(*) from agent_task_keys k where k.agent_id=a.id) as start_keys,
      (select count(*) from agent_continue_keys k where k.agent_id=a.id) as continue_keys
      from console_executions e join local_agent_sessions a on a.id=e.agent_id where e.run_id=? order by e.created_at limit 101`).all(run.id) as Record<string, unknown>[];
    return { runHash: hash(run.id), projectHash: hash(run.project_id), workspaceHash: hash(run.workspace_id),
      createdAt: run.created_at, finishedAt: run.finished_at, truncated: rows.length > 100,
      executions: rows.slice(0, 100).map((row) => ({ executionHash: hash(row.execution_id), agentHash: hash(row.agent_id),
        providerSessionHash: hash(row.provider_session_id), threadHash: hash(row.managed_thread_id), workspaceHash: hash(row.workspace_id),
        workItemHash: hash(row.work_item_id), contextHash: hash(row.context_key), signatureHash: hash(row.context_signature),
        createdAt: row.created_at, finishedAt: row.finished_at,
        status: ["starting", "running", "queued", "completed", "failed", "cancelled"].includes(String(row.status)) ? row.status : "unknown",
        agentStatus: ["starting", "running", "queued", "idle", "error", "stopped"].includes(String(row.agent_status)) ? row.agent_status : "unknown",
        errorCodeHash: hash(row.error_code), startKeys: row.start_keys, continueKeys: row.continue_keys })),
      note: "Agent identity fields are current, not historical execution inputs; no prompts, titles, responses or arbitrary evidence read." };
  })();
  console.log(JSON.stringify(result));
} finally { db.close(); }
