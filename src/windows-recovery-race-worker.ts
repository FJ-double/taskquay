/** Disposable subprocess used exclusively by windows-recovery-concurrency.test.ts.
 * Invokes the REAL native recovery observer, never synthetic PID/Job evidence.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectManagedRecovery } from "./windows-recovery-transaction.js";

const [dir, id] = process.argv.slice(2);
if (process.platform !== "win32" || !dir || !/^ex_[a-f0-9]{32}$/.test(id ?? "")) {
  process.exit(78);
}
let waitedMs = 0;
while (!existsSync(join(dir, "race-start"))) {
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  waitedMs += 25;
  if (waitedMs > 20_000) throw new Error("RECOVERY_RACE_BARRIER_TIMEOUT");
}
const db = new Database(join(dir, "devspace.sqlite"));
db.pragma("busy_timeout = 10000");
try {
  const report = inspectManagedRecovery(db, id, { apply: true });
  process.stdout.write(JSON.stringify({ status: report.status }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ status: "rejected", error: message }));
} finally {
  db.close();
}
