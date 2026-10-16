/** Disposable TEST-only queue orphan recovery process. */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectManagedQueueOrphan } from "./managed-queue-orphan-recovery.js";

const [dir, ticketId] = process.argv.slice(2);
if (process.platform !== "win32" || !dir || !/^claim_[a-f0-9]{32}$/i.test(ticketId ?? "")) {
  process.exit(79);
}
for (let i = 0; !existsSync(join(dir, "queue-race-go")); i++) {
  if (i > 600) throw new Error("QUEUE_RACE_BARRIER_TIMEOUT");
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}
const sqlite = new Database(join(dir, "devspace.sqlite"));
sqlite.pragma("busy_timeout = 10000");
try {
  const result = inspectManagedQueueOrphan(sqlite, ticketId, { apply: true });
  process.stdout.write(JSON.stringify({ status: result.status }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: "rejected", reason: error instanceof Error ? error.message : String(error),
  }));
} finally { sqlite.close(); }
