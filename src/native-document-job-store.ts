import { chmodSync } from "node:fs";
import Database from "better-sqlite3";

export interface DocumentJobRow { id: string; data: string }

/** Separate from the work ledger: FULL-synchronous transactions preserve the
 * pre-commit receipt barrier without serializing every retained document result. */
export class NativeDocumentJobStore {
  private readonly db: Database.Database;
  private closed = false;
  readonly metrics = { transactions: 0, upsertedRows: 0, deletedRows: 0, serializedBytes: 0 };
  constructor(path: string) {
    this.db = new Database(path, { timeout: 25 });
    try {
      chmodSync(path, 0o600);
      this.db.pragma("busy_timeout = 25");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.pragma("wal_autocheckpoint = 256");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1) throw new Error("Unsupported document job store version.");
      this.db.exec("CREATE TABLE IF NOT EXISTS document_jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS document_job_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
    } catch (error) { this.db.close(); throw error; }
  }
  get initialized(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM document_job_metadata WHERE key='initialized'").get());
  }
  get sourceJournalHash(): string | undefined {
    return (this.db.prepare("SELECT value FROM document_job_metadata WHERE key='source_journal_sha256'").get() as { value: string } | undefined)?.value;
  }
  load(maxRecords: number, maxBytes: number): unknown[] {
    const counts = this.db.prepare("SELECT count(*) AS records, coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM document_jobs").get() as { records: number; bytes: number };
    if (counts.records > maxRecords || counts.bytes > maxBytes) throw new Error("Document job store exceeds configured recovery capacity.");
    return (this.db.prepare("SELECT data FROM document_jobs ORDER BY rowid").all() as DocumentJobRow[]).map(row => JSON.parse(row.data));
  }
  save(rows: readonly DocumentJobRow[], deleted: readonly string[], initialize = false, sourceJournalHash?: string): void {
    if (this.closed) throw new Error("Document job store is closed.");
    if (!rows.length && !deleted.length && !initialize) return;
    const upsert = this.db.prepare("INSERT INTO document_jobs(id,data,bytes) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes");
    const remove = this.db.prepare("DELETE FROM document_jobs WHERE id=?");
    this.db.transaction(() => {
      for (const id of deleted) remove.run(id);
      for (const row of rows) upsert.run(row.id, row.data, Buffer.byteLength(row.data));
      if (initialize) this.db.prepare("INSERT OR IGNORE INTO document_job_metadata(key,value) VALUES('initialized','1')").run();
      if (initialize && sourceJournalHash) this.db.prepare("INSERT OR IGNORE INTO document_job_metadata(key,value) VALUES('source_journal_sha256',?)").run(sourceJournalHash);
    })();
    this.metrics.transactions++;
    this.metrics.upsertedRows += rows.length; this.metrics.deletedRows += deleted.length;
    this.metrics.serializedBytes += rows.reduce((n, row) => n + Buffer.byteLength(row.data), 0);
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
