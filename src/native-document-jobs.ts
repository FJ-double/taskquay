import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { documentReply, encodeDocumentResult, MAX_DOCUMENT_REPLY_BYTES } from "./native-document-replies.js";
import { validateDocumentInputSize, type DocumentInput } from "./native-documents.js";
import type { DocumentExecutionStage } from "./native-document-executor.js";
import { NativeDocumentJobStore } from "./native-document-job-store.js";

export interface DocumentJobScope { workspaceId: string; workspaceRoot: string; callerId: string }
export interface DocumentJobReply { operationId: string; result: string; durable: boolean; isError?: boolean }
export type DocumentJobStatus = "queued" | "running" | "finalizing" | "succeeded" | "failed" | "cancelled" | "interrupted" | "outcome_unknown";
interface RecordData {
  id: string; scopeHash: string; path: string; action: DocumentInput["action"]; write: boolean; fingerprint: string; keyHash?: string;
  status: DocumentJobStatus; createdAt: number; updatedAt: number; expiresAt: number; resultExpiresAt?: number; result?: string;
  error?: string; cancelRequested?: boolean; resultExpired?: boolean; revision: number;
}
interface ActiveJob { controller: AbortController; done: Promise<void>; finish(): void }
export interface NativeDocumentJobsOptions {
  stateDir?: string;
  maxRecords?: number;
  /** Completed reads without a request key have a separate evictable cache. */
  maxReadRecords?: number;
  maxActive?: number;
  maxBytes?: number;
  resultTtlMs?: number;
  recoveryTtlMs?: number;
  now?: () => number;
}
export interface DocumentJobSubmission {
  scope: DocumentJobScope; path: string; input: DocumentInput; requestKey?: string; waitMs?: number; signal?: AbortSignal;
}
export type DocumentJobRun = (signal: AbortSignal, onStage: (stage: DocumentExecutionStage) => Promise<void>) => Promise<string>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalized = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const writes = new Set(["cell_set", "cells_set", "text_replace", "pdf_append_blank"]);
const pending = (record: RecordData) => ["queued", "running", "finalizing"].includes(record.status);
const protectedRecord = (record: RecordData) => record.write || record.keyHash !== undefined;
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
}
function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive safe integer.`);
  return result;
}
function scopeHash(scope: DocumentJobScope): string { return hash(JSON.stringify([scope.workspaceId, normalized(scope.workspaceRoot), scope.callerId])); }
export function documentJobCaller(extra: { authInfo?: { clientId?: string }; _meta?: Record<string, unknown> }): string {
  const client = extra.authInfo?.clientId;
  if (typeof client === "string" && client) return "oauth:" + hash(client);
  const session = extra._meta?.["openai/session"];
  // The external HTTP endpoint authenticates before this handler. Unauthenticated local transports are already trusted local access.
  return "local:" + hash(typeof session === "string" && session.length <= 1024 ? session : "local-owner");
}

/** Durable bounded receipts. Raw tool arguments, bearer tokens and authentication headers are never persisted. */
export class NativeDocumentJobs {
  private readonly records = new Map<string, RecordData>();
  private readonly active = new Map<string, ActiveJob>();
  private readonly persistedRevision = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly encoded = new Map<string, string>();
  private readonly recordBytes = new Map<string, number>();
  private readonly readAccess = new Map<string, number>();
  private accessSequence = 0;
  private store?: NativeDocumentJobStore;
  private readonly maxRecords: number;
  private readonly maxReadRecords: number;
  private readonly maxActive: number;
  private readonly maxBytes: number;
  private readonly resultTtlMs: number;
  private readonly recoveryTtlMs: number;
  private readonly now: () => number;
  private readonly journal?: string;
  private readonly lock?: string;
  private readonly owner = randomUUID();
  private readonly initialized: Promise<void>;
  private saving = Promise.resolve();
  private closed = false;
  private ready = false;
  private closing?: Promise<void>;
  constructor(options: NativeDocumentJobsOptions = {}) {
    this.maxRecords = limit(options.maxRecords, 512, "maxRecords"); this.maxActive = limit(options.maxActive, 10, "maxActive");
    this.maxReadRecords = limit(options.maxReadRecords, 128, "maxReadRecords");
    this.maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, "maxBytes");
    this.resultTtlMs = limit(options.resultTtlMs, 60 * 60 * 1000, "resultTtlMs");
    this.recoveryTtlMs = limit(options.recoveryTtlMs, 24 * 60 * 60 * 1000, "recoveryTtlMs"); this.now = options.now ?? Date.now;
    if (options.stateDir) { this.journal = join(options.stateDir, "native-document-jobs.json"); this.lock = this.journal + ".lock"; }
    this.initialized = this.initialize().then(() => { this.ready = true; }); void this.initialized.catch(() => undefined);
  }
  private async initialize(): Promise<void> {
    if (!this.journal || !this.lock) return;
    await mkdir(resolve(this.journal, ".."), { recursive: true });
    const recoveryGuard = this.lock + ".recovery";
    try { await stat(recoveryGuard); throw new Error("Document job lock recovery is guarded; inspect the recovery guard before starting another server."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let lock;
    try { lock = await open(this.lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-owner inspection and deletion. A second recovery must never delete a new live lock.
      const guard = await open(recoveryGuard, "wx", 0o600).catch(() => { throw new Error("Document job lock recovery is already guarded; inspect before retrying."); });
      try {
        await guard.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner })); await guard.sync();
        const owner = JSON.parse(await readFile(this.lock, "utf8")) as { pid?: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid! < 1) throw new Error("Document job journal lock is invalid; recovery requires inspection.");
        try { process.kill(owner.pid!, 0); throw new Error("Document job journal is already owned by a live server."); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
        await rm(this.lock); lock = await open(this.lock, "wx", 0o600);
      } finally { await guard.close(); await rm(recoveryGuard); }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner })); await lock.sync();
    } finally { await lock.close(); }
    try {
      let bytes: Buffer | undefined;
      try {
        const file = await open(this.journal, "r");
        try {
          if ((await file.stat()).size > this.maxBytes) throw new Error("Document job journal exceeds its capacity; inspect recovery data.");
          const chunks: Buffer[] = []; let total = 0;
          while (total <= this.maxBytes) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, this.maxBytes + 1 - total)); const read = await file.read(chunk);
            if (!read.bytesRead) break; chunks.push(chunk.subarray(0, read.bytesRead)); total += read.bytesRead;
          }
          if (total > this.maxBytes) throw new Error("Document job journal exceeds its capacity; inspect recovery data.");
          bytes = Buffer.concat(chunks, total);
        } finally { await file.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const manifest = bytes ? JSON.parse(bytes.toString("utf8")) as { version: number; records?: RecordData[]; database?: string } : undefined;
      if (bytes && (!manifest || typeof manifest !== "object" || Array.isArray(manifest))) throw new Error("Invalid document job recovery journal.");
      if (manifest && manifest.version !== 1 && (manifest.version !== 2 || manifest.database !== "native-document-jobs.sqlite")) throw new Error("Invalid document job recovery journal.");
      if (manifest?.version === 1 && !Array.isArray(manifest.records)) throw new Error("Invalid document job recovery journal records.");
      this.store = new NativeDocumentJobStore(join(resolve(this.journal, ".."), "native-document-jobs.sqlite"));
      const existingStore = this.store.initialized;
      const sourceJournalHash = manifest?.version === 1 && bytes ? hash(bytes.toString("base64")) : undefined;
      if (existingStore && sourceJournalHash && this.store.sourceJournalHash !== sourceJournalHash)
        throw new Error("Legacy journal changed after migration began; preserve both recovery stores for inspection. No work was replayed.");
      if (manifest?.version === 2 && !existingStore) throw new Error("Document recovery database is missing or uninitialized; no work was replayed.");
      const records = existingStore ? this.store.load(this.maxRecords + this.maxReadRecords + this.maxActive, this.maxBytes) as RecordData[]
        : manifest?.records ?? [];
      if (!Array.isArray(records) || records.length > this.maxRecords + this.maxReadRecords + this.maxActive) throw new Error("Invalid document job recovery capacity.");
      for (const record of records) {
          if (!record || this.records.has(record.id) || !/^op_[a-f0-9]{32}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.scopeHash) || typeof record.path !== "string"
            || typeof record.fingerprint !== "string" || typeof record.write !== "boolean" || !Number.isSafeInteger(record.revision)
            || !Number.isFinite(record.expiresAt) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
            || !["queued", "running", "finalizing", "succeeded", "failed", "cancelled", "interrupted", "outcome_unknown"].includes(record.status)
            || (record.result !== undefined && (typeof record.result !== "string" || Buffer.byteLength(JSON.stringify({ result: record.result })) > MAX_DOCUMENT_REPLY_BYTES)))
            throw new Error("Invalid document job recovery record; no work was replayed.");
          this.records.set(record.id, record); this.recordBytes.set(record.id, Buffer.byteLength(JSON.stringify(record)));
          this.persistedRevision.set(record.id, record.revision); this.readAccess.set(record.id, ++this.accessSequence);
          if (pending(record)) {
            record.status = record.status === "finalizing" && record.write ? "outcome_unknown" : "interrupted";
            record.error = record.status === "outcome_unknown" ? "Server stopped during a possible document commit. Inspect the file and backups; do not replay automatically."
              : "Server stopped before a completion receipt was saved. This job will not be restarted automatically.";
            record.expiresAt = protectedRecord(record) ? Math.max(record.expiresAt, this.now() + this.recoveryTtlMs) : this.now() + this.resultTtlMs;
            this.touch(record);
          }
      }
      if (!existingStore) this.store.save([...this.records.values()].map(record => ({ id: record.id, data: JSON.stringify(record) })), [], true, sourceJournalHash);
      if (manifest?.version !== 2) {
        // The marker makes older servers refuse stale JSON instead of silently
        // losing newer receipts on downgrade. Keep an exact v1 migration backup.
        if (manifest?.version === 1 && bytes) {
          const backup = this.journal + ".v1-backup";
          try {
            if (hash((await readFile(backup)).toString("base64")) !== sourceJournalHash) throw new Error("Conflicting document journal migration backup; inspect recovery data.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const temporaryBackup = backup + "." + randomUUID() + ".tmp";
            try {
              const file = await open(temporaryBackup, "wx", 0o600);
              try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
              // The exclusive journal lock also covers migration. Never expose a
              // partially written backup as the completed recovery artifact.
              await rename(temporaryBackup, backup);
            } catch (failure) { await rm(temporaryBackup, { force: true }).catch(() => undefined); throw failure; }
          }
        }
        const temp = this.journal + "." + randomUUID() + ".tmp";
        try {
          const file = await open(temp, "wx", 0o600);
          try { await file.writeFile(JSON.stringify({ version: 2, database: "native-document-jobs.sqlite" })); await file.sync(); } finally { await file.close(); }
          await rename(temp, this.journal);
        } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
      }
      this.prune(); this.trimReadCache(); await this.save();
    } catch (error) { this.store?.close(); await this.releaseLock(); throw error; }
  }
  private touch(record: RecordData): void {
    record.updatedAt = this.now(); record.revision++; this.dirty.add(record.id); this.encode(record);
  }
  private encode(record: RecordData): void {
    const value = JSON.stringify(record); this.encoded.set(record.id, value); this.recordBytes.set(record.id, Buffer.byteLength(value));
  }
  private remove(record: RecordData): void {
    if (this.persistedRevision.has(record.id)) this.deleted.add(record.id);
    this.records.delete(record.id); this.encoded.delete(record.id); this.recordBytes.delete(record.id); this.readAccess.delete(record.id);
    this.persistedRevision.delete(record.id); this.dirty.delete(record.id);
  }
  private prune(): boolean {
    let changed = false;
    for (const [id, record] of this.records) {
      if (pending(record) || this.active.has(id)) continue;
      if (record.expiresAt <= this.now() || (!protectedRecord(record) && record.resultExpiresAt !== undefined && record.resultExpiresAt <= this.now())) { this.remove(record); changed = true; }
      else if (record.result !== undefined && record.resultExpiresAt! <= this.now()) { delete record.result; record.resultExpired = true; this.touch(record); changed = true; }
    }
    return changed;
  }
  private reservedBytes(): number {
    let bytes = 128;
    for (const record of this.records.values()) bytes += this.recordBytes.get(record.id)! + 2 + (pending(record) ? MAX_DOCUMENT_REPLY_BYTES : 0);
    return bytes;
  }
  private trimReadCache(reserveCount = 0, reserveBytes = 0): void {
    const reads = [...this.records.values()].filter(record => !protectedRecord(record));
    const evictable = reads.filter(record => !pending(record) && !this.active.has(record.id))
      .sort((a, b) => (this.readAccess.get(a.id) ?? 0) - (this.readAccess.get(b.id) ?? 0));
    let count = reads.length;
    for (const record of evictable) {
      if (count + reserveCount <= this.maxReadRecords && this.reservedBytes() + reserveBytes <= this.maxBytes) break;
      this.remove(record); count--;
    }
  }
  diagnostics() {
    return { protectedRecords: [...this.records.values()].filter(protectedRecord).length,
      readCacheRecords: [...this.records.values()].filter(record => !protectedRecord(record)).length,
      active: this.active.size, reservedBytes: this.reservedBytes(), storage: this.store ? { ...this.store.metrics } : undefined };
  }
  private save(): Promise<void> {
    const operation = this.saving.catch(() => undefined).then(async () => {
      const records = [...this.dirty].map(id => this.records.get(id)).filter((record): record is RecordData => Boolean(record));
      const removed = [...this.deleted];
      this.store?.save(records.map(record => ({ id: record.id, data: this.encoded.get(record.id)! })), removed);
      for (const record of records) { this.persistedRevision.set(record.id, record.revision); this.dirty.delete(record.id); this.encoded.delete(record.id); }
      for (const id of removed) this.deleted.delete(id);
    });
    this.saving = operation; return operation;
  }
  private owned(id: string, scope: DocumentJobScope): RecordData {
    const record = this.records.get(id);
    if (!record || record.scopeHash !== scopeHash(scope)) throw new Error("Document operation is unavailable or its read cache expired in this workspace/caller scope.");
    if (!protectedRecord(record)) this.readAccess.set(id, ++this.accessSequence);
    return record;
  }
  async lookup(id: string, scope: DocumentJobScope): Promise<{ path: string; action: DocumentInput["action"] }> {
    await this.initialized; if (this.closed) throw new Error("Document job manager is closed.");
    if (this.prune()) await this.save().catch(() => undefined); const record = this.owned(id, scope); return { path: record.path, action: record.action };
  }
  private status(record: RecordData, scope: DocumentJobScope): DocumentJobReply {
    const available = record.status === "succeeded" && record.result !== undefined;
    const value = { operation_id: record.id, status: record.status, result_available: available,
      durable: Boolean(this.journal) && this.persistedRevision.get(record.id) === record.revision,
      result_expired: record.resultExpired === true, cancel_requested: record.cancelRequested === true,
      outcome: record.status === "succeeded" ? "completed" : record.status === "outcome_unknown" ? "unknown" : pending(record) ? "pending" : "not_completed",
      ...(record.error ? { error: record.error } : {}),
      nextAction: available ? { tool: "document_tool", action: "result", workspace_id: scope.workspaceId, operation_id: record.id }
        : pending(record) ? { tool: "document_tool", action: "status", workspace_id: scope.workspaceId, operation_id: record.id }
          : { action: "inspect_outcome", guidance: "Do not replay an interrupted/unknown write. Inspect the file and backups first; an expired result does not authorize re-execution." } };
    return { operationId: record.id, result: encodeDocumentResult(value), durable: value.durable, isError: ["failed", "interrupted", "outcome_unknown"].includes(record.status) || undefined };
  }
  private reply(record: RecordData, scope: DocumentJobScope): DocumentJobReply {
    return record.status === "succeeded" && record.result !== undefined ? { operationId: record.id, result: record.result,
      durable: Boolean(this.journal) && this.persistedRevision.get(record.id) === record.revision } : this.status(record, scope);
  }
  private async wait(record: RecordData, waitMs: number, signal?: AbortSignal): Promise<void> {
    const active = this.active.get(record.id); if (!active || !waitMs || signal?.aborted) return;
    await new Promise<void>(resolveWait => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolveWait(); };
      const timer = setTimeout(finish, waitMs); signal?.addEventListener("abort", finish, { once: true }); void active.done.then(finish);
    });
  }
  async submit(submission: DocumentJobSubmission, run: DocumentJobRun): Promise<DocumentJobReply> {
    submission.signal?.throwIfAborted();
    await this.initialized; if (this.closed) throw new Error("Document job manager is closed.");
    submission.signal?.throwIfAborted();
    validateDocumentInputSize(submission.input); this.prune();
    const waitMs = submission.waitMs ?? 1000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 1000) throw new Error("Document wait must be 0–1000 ms.");
    if (submission.requestKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(submission.requestKey)) throw new Error("Invalid document request_key.");
    const owner = scopeHash(submission.scope), keyHash = submission.requestKey === undefined ? undefined : hash(submission.requestKey);
    const fingerprint = hash(JSON.stringify(canonical({ ...submission.input, path: normalized(submission.path) })));
    if (keyHash) {
      const previous = [...this.records.values()].find(record => record.scopeHash === owner && record.keyHash === keyHash);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Document request_key conflicts with different input; no new operation was started.");
        await this.wait(previous, waitMs, submission.signal); return this.reply(previous, submission.scope);
      }
    }
    const protect = writes.has(submission.input.action) || keyHash !== undefined;
    if ((protect && [...this.records.values()].filter(protectedRecord).length >= this.maxRecords) || this.active.size >= this.maxActive)
      throw new Error("Document job capacity is full; existing jobs/retained idempotency records were not evicted.");
    const now = this.now(), record: RecordData = { id: "op_" + randomUUID().replaceAll("-", ""), scopeHash: owner, path: resolve(submission.path),
      action: submission.input.action, write: writes.has(submission.input.action), fingerprint, keyHash, status: "queued", createdAt: now, updatedAt: now,
      expiresAt: now + this.recoveryTtlMs, revision: 1 };
    this.records.set(record.id, record);
    this.encode(record); this.dirty.add(record.id); this.readAccess.set(record.id, ++this.accessSequence);
    this.trimReadCache();
    if (this.reservedBytes() > this.maxBytes || (!protect && [...this.records.values()].filter(record => !protectedRecord(record)).length > this.maxReadRecords)) {
      this.remove(record); throw new Error("Document job storage capacity is full; active jobs and retained recovery records were not evicted.");
    }
    let finish!: () => void; const active: ActiveJob = { controller: new AbortController(), done: new Promise<void>(resolveDone => { finish = resolveDone; }), finish: () => finish() };
    this.active.set(record.id, active);
    try { await this.save(); }
    catch (error) { record.status = "failed"; record.error = "Job journal could not be saved; the operation was not started."; this.touch(record); this.active.delete(record.id); active.finish(); throw error; }
    void this.run(record, active, run).finally(() => { this.active.delete(record.id); active.finish(); });
    await this.wait(record, waitMs, submission.signal); return this.reply(record, submission.scope);
  }
  private async run(record: RecordData, active: ActiveJob, execute: DocumentJobRun): Promise<void> {
    try {
      record.status = "running"; this.touch(record); await this.save();
      active.controller.signal.throwIfAborted();
      const result = await execute(active.controller.signal, async stage => {
        if (stage === "finalizing" && record.write) { record.status = "finalizing"; this.touch(record); await this.save(); }
      });
      if (Buffer.byteLength(JSON.stringify({ ...documentReply(result), structuredContent: { result, operation_id: record.id, durable: false } })) > MAX_DOCUMENT_REPLY_BYTES) {
        record.status = record.write ? "outcome_unknown" : "failed"; record.error = "Operation completed but its result exceeded recovery capacity. Inspect the outcome; do not replay a write.";
      } else { record.status = "succeeded"; record.result = result; record.resultExpiresAt = this.now() + this.resultTtlMs; }
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      record.status = aborted ? "cancelled" : record.status === "finalizing" && record.write ? "outcome_unknown" : "failed";
      record.error = error instanceof Error ? error.message.slice(0, 1024) : "Document operation failed.";
    }
    record.expiresAt = this.now() + (protectedRecord(record) ? this.recoveryTtlMs : this.resultTtlMs); this.touch(record);
    // A failed receipt write must never relabel a completed filesystem mutation as unexecuted.
    await this.save().catch(() => undefined);
  }
  async query(id: string, scope: DocumentJobScope, action: "status" | "result" | "cancel", waitMs = 0, signal?: AbortSignal): Promise<DocumentJobReply> {
    await this.initialized; if (this.closed) throw new Error("Document job manager is closed.");
    if (this.prune()) await this.save().catch(() => undefined); const record = this.owned(id, scope);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 1000) throw new Error("Document wait must be 0–1000 ms.");
    if (action === "cancel" && this.active.has(id)) {
      record.cancelRequested = true; this.touch(record); this.active.get(id)!.controller.abort(); await this.save().catch(() => undefined);
    }
    await this.wait(record, waitMs, signal); return action === "result" ? this.reply(record, scope) : this.status(record, scope);
  }
  private async releaseLock(): Promise<void> {
    if (!this.lock) return;
    try { if ((JSON.parse(await readFile(this.lock, "utf8")) as { owner?: string }).owner === this.owner) await rm(this.lock); } catch { /* Do not remove another owner's lock. */ }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; await this.initialized.catch(() => undefined);
      for (const active of this.active.values()) active.controller.abort();
      await Promise.all([...this.active.values()].map(active => active.done));
      if (this.ready) { this.prune(); await this.save().catch(() => undefined); }
      await this.saving.catch(() => undefined); this.store?.close(); await this.releaseLock();
    })();
  }
}
