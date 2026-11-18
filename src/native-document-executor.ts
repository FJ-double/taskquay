import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { finalizeDocumentOperation, loadDocumentSource, validateDocumentInputSize, type DocumentInput, type DocumentPreparedResult } from "./native-documents.js";

export interface DocumentOperationMeasurement {
  operation_id: number;
  worker_id?: number;
  status: "succeeded" | "failed" | "aborted" | "timed_out" | "closed";
  queue_ms: number;
  read_ms: number;
  worker_ms: number;
  finalize_ms: number;
  total_ms: number;
  cache_hit: boolean;
  cache_bytes: number;
  hash_ms: number;
  parse_ms: number;
  serialize_ms: number;
}

export interface NativeDocumentExecutorOptions {
  maxWorkers?: number;
  maxQueue?: number;
  timeoutMs?: number;
  onMeasurement?: (measurement: DocumentOperationMeasurement) => void;
  /** Trusted deployment/test entry point; never accepted from document tool input. */
  workerUrl?: URL;
}
export type DocumentExecutionStage = "reading" | "working" | "finalizing";

export class DocumentExecutorError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = "DocumentExecutorError"; }
}

interface WorkerHandle { worker: Worker; exited: Promise<void>; expectedStop: boolean }
interface WorkerSlot {
  id: number;
  handle?: WorkerHandle;
  stopping?: Promise<void>;
  operation?: Promise<void>;
  job?: Job;
  pending?: { id: number; handle: WorkerHandle; resolve(value: DocumentPreparedResult): void; reject(error: Error): void };
}
interface Job {
  id: number;
  path: string;
  affinity: string;
  input: DocumentInput;
  enqueuedAt: number;
  deadlineAt: number;
  controller: AbortController;
  signal?: AbortSignal;
  onStage?: (stage: DocumentExecutionStage) => void | Promise<void>;
  abort?: () => void;
  timer?: NodeJS.Timeout;
  slot?: WorkerSlot;
  stage: "queued" | "reading" | "working" | "finalizing" | "done";
  canceled?: Error;
  measurement: DocumentOperationMeasurement;
  resolve(value: string): void;
  reject(error: unknown): void;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  return result;
}
function canceledError(): Error { const error = new Error("Document operation canceled before commit."); error.name = "AbortError"; return error; }
function timeoutError(): Error { const error = new Error("Document operation timed out before commit."); error.name = "TimeoutError"; return error; }
function closedError(): Error { return new DocumentExecutorError("DOCUMENT_EXECUTOR_CLOSED", "Document executor is closed."); }
function workerError(cause?: unknown): Error { return new DocumentExecutorError("DOCUMENT_WORKER_FAILED", "Document worker exited unexpectedly; no write performed.", { cause }); }
function elapsed(start: number): number { return Math.max(0, performance.now() - start); }
function numeric(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function percentiles(values: number[]) {
  values.sort((a, b) => a - b);
  return { p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : 0, p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : 0 };
}

/** A cooperative execution boundary, not an operating-system sandbox. */
export class NativeDocumentExecutor {
  private readonly slots: WorkerSlot[];
  private readonly queue: Job[] = [];
  private readonly affinity = new Map<string, number>();
  private readonly measurements: DocumentOperationMeasurement[] = [];
  private readonly maxQueue: number;
  private readonly timeoutMs: number;
  private readonly workerUrl: URL;
  private closed = false;
  private closing?: Promise<void>;
  private sequence = 0;
  private created = 0;
  private crashes = 0;
  private rejected = 0;
  private settled = 0;

  constructor(private readonly options: NativeDocumentExecutorOptions = {}) {
    this.slots = Array.from({ length: integer(options.maxWorkers, 2, 1, 8, "maxWorkers") }, (_, id) => ({ id }));
    this.maxQueue = integer(options.maxQueue, 8, 0, 64, "maxQueue");
    this.timeoutMs = integer(options.timeoutMs, 60_000, 1, 600_000, "timeoutMs");
    this.workerUrl = options.workerUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./native-document-worker.ts" : "./native-document-worker.js", import.meta.url);
  }

  execute(path: string, input: DocumentInput, options: { signal?: AbortSignal; onStage?: (stage: DocumentExecutionStage) => void | Promise<void> } = {}): Promise<string> {
    if (this.closed) return Promise.reject(closedError());
    if (options.signal?.aborted) return Promise.reject(canceledError());
    try { validateDocumentInputSize(input); }
    catch (error) { this.rejected += 1; return Promise.reject(error); }
    if (this.queue.length >= this.maxQueue && !this.availableSlot(resolve(path))) {
      this.rejected += 1;
      return Promise.reject(new DocumentExecutorError("DOCUMENT_QUEUE_FULL", "Document worker queue is full; retry after an active operation finishes."));
    }
    let snapshot: DocumentInput;
    try { snapshot = structuredClone(input); } catch (error) { return Promise.reject(error); }
    return new Promise<string>((resolveResult, reject) => {
      const now = performance.now();
      const id = ++this.sequence;
      const identity = resolve(path);
      const job: Job = {
        id, path, affinity: process.platform === "win32" ? identity.toLowerCase() : identity, input: snapshot,
        enqueuedAt: now, deadlineAt: now + this.timeoutMs, controller: new AbortController(), signal: options.signal, onStage: options.onStage,
        stage: "queued", resolve: resolveResult, reject,
        measurement: { operation_id: id, status: "failed", queue_ms: 0, read_ms: 0, worker_ms: 0, finalize_ms: 0,
          total_ms: 0, cache_hit: false, cache_bytes: 0, hash_ms: 0, parse_ms: 0, serialize_ms: 0 },
      };
      job.abort = () => this.cancel(job, canceledError());
      job.signal?.addEventListener("abort", job.abort, { once: true });
      job.timer = setTimeout(() => this.cancel(job, timeoutError()), this.timeoutMs);
      this.queue.push(job);
      if (job.signal?.aborted) this.cancel(job, canceledError());
      else this.drain();
    });
  }

  recentMeasurements(): DocumentOperationMeasurement[] { return this.measurements.map((value) => ({ ...value })); }

  diagnostics() {
    return {
      closed: this.closed, workers: this.slots.filter((slot) => slot.handle).length,
      active: this.slots.filter((slot) => slot.job).length, queued: this.queue.length,
      max_workers: this.slots.length, max_queue: this.maxQueue, created: this.created, crashes: this.crashes,
      rejected: this.rejected, settled: this.settled, recent_count: this.measurements.length,
      total_ms: percentiles(this.measurements.map((value) => value.total_ms)),
      queue_ms: percentiles(this.measurements.map((value) => value.queue_ms)),
      worker_ms: percentiles(this.measurements.map((value) => value.worker_ms)),
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      for (const job of [...this.queue]) this.cancel(job, closedError());
      for (const slot of this.slots) if (slot.job) this.cancel(slot.job, closedError());
      await Promise.all(this.slots.map(async (slot) => {
        await this.stop(slot, closedError());
        await slot.operation;
        await this.stop(slot, closedError());
      }));
      this.affinity.clear();
    });
    return this.closing;
  }

  private availableSlot(path: string): WorkerSlot | undefined {
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    const assigned = this.affinity.get(identity);
    if (assigned !== undefined && !this.slots[assigned].job && !this.slots[assigned].stopping) return this.slots[assigned];
    let hash = 0;
    for (let index = 0; index < identity.length; index += 1) hash = (Math.imul(hash, 31) + identity.charCodeAt(index)) >>> 0;
    const preferred = this.slots[hash % this.slots.length];
    return !preferred.job && !preferred.stopping ? preferred : this.slots.find((slot) => !slot.job && !slot.stopping);
  }

  private drain(): void {
    if (this.closed) return;
    while (this.queue.length) {
      const job = this.queue[0];
      if (performance.now() >= job.deadlineAt) { this.cancel(job, timeoutError()); continue; }
      const slot = this.availableSlot(job.affinity);
      if (!slot) return;
      this.queue.shift();
      slot.job = job;
      job.slot = slot;
      job.stage = "reading";
      job.measurement.worker_id = slot.id;
      job.measurement.queue_ms = elapsed(job.enqueuedAt);
      slot.operation = this.run(slot, job);
    }
  }

  private cancel(job: Job, error: Error): void {
    // Finalization is the host commit boundary. Its real outcome remains
    // authoritative even if cancellation arrives while filesystem I/O awaits.
    if (job.stage === "done" || job.stage === "finalizing" || job.canceled) return;
    job.canceled = error;
    job.controller.abort(error);
    if (job.stage === "queued") {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      job.measurement.queue_ms = elapsed(job.enqueuedAt);
      this.settle(job, undefined, error);
    } else if (job.slot) void this.stop(job.slot, error);
  }

  private async run(slot: WorkerSlot, job: Job): Promise<void> {
    let result: string | undefined;
    let failure: unknown;
    try {
      await job.onStage?.("reading");
      this.check(job);
      let started = performance.now();
      let source: Buffer;
      try { source = await loadDocumentSource(job.path, job.controller.signal); }
      finally { job.measurement.read_ms = elapsed(started); }
      this.check(job);
      job.stage = "working";
      await job.onStage?.("working");
      this.check(job);
      started = performance.now();
      let prepared: DocumentPreparedResult;
      try { prepared = await this.prepare(slot, job, source); }
      finally { job.measurement.worker_ms = elapsed(started); }
      const writeAction = ["cell_set", "cells_set", "text_replace", "pdf_append_blank"].includes(job.input.action);
      if (prepared.kind !== (writeAction ? "write" : "read") || !prepared.metrics || typeof prepared.metrics !== "object" || Array.isArray(prepared.metrics)
        || (prepared.kind === "read" && typeof prepared.result !== "string")
        || (prepared.kind === "write" && (!(prepared.output instanceof Uint8Array) || prepared.output.byteLength > 20 * 1024 * 1024
          || typeof prepared.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(prepared.sourceHash)
          || !prepared.response || typeof prepared.response !== "object" || Array.isArray(prepared.response)))) {
        const error = new DocumentExecutorError("DOCUMENT_WORKER_PROTOCOL", "Document worker preparation does not match the requested action; no write performed.");
        await this.stop(slot, error);
        throw error;
      }
      for (const key of ["hash_ms", "parse_ms", "serialize_ms", "cache_bytes"] as const) job.measurement[key] = numeric(prepared.metrics[key]);
      job.measurement.cache_hit = prepared.metrics.cache_hit === true;
      this.check(job);
      // A durable job journal must record the possible commit before any filesystem replacement.
      await job.onStage?.("finalizing");
      this.check(job);
      job.stage = "finalizing";
      started = performance.now();
      try { result = await finalizeDocumentOperation(job.path, prepared, source); }
      finally { job.measurement.finalize_ms = elapsed(started); }
      this.affinity.delete(job.affinity);
      this.affinity.set(job.affinity, slot.id);
      if (this.affinity.size > 100) this.affinity.delete(this.affinity.keys().next().value!);
    } catch (error) { failure = job.canceled ?? error; }
    finally {
      if (job.canceled || slot.stopping) await this.stop(slot, job.canceled ?? workerError());
      slot.job = undefined;
      slot.handle?.worker.unref();
      this.settle(job, result, failure);
      this.drain();
    }
  }

  private check(job: Job): void {
    if (job.canceled) throw job.canceled;
    if (this.closed) { this.cancel(job, closedError()); throw job.canceled ?? closedError(); }
    if (performance.now() >= job.deadlineAt) { this.cancel(job, timeoutError()); throw job.canceled ?? timeoutError(); }
    if (job.signal?.aborted) { this.cancel(job, canceledError()); throw job.canceled ?? canceledError(); }
  }

  private prepare(slot: WorkerSlot, job: Job, source: Buffer): Promise<DocumentPreparedResult> {
    const handle = this.worker(slot);
    handle.worker.ref();
    // Keep the host source for optimistic finalization/backups. Transfer only
    // one dedicated copy; queued files have never been loaded.
    const bytes = Uint8Array.from(source);
    return new Promise((resolvePrepared, reject) => {
      slot.pending = { id: job.id, handle, resolve: resolvePrepared, reject };
      try { handle.worker.postMessage({ id: job.id, path: job.path, input: job.input, bytes }, [bytes.buffer]); }
      catch (error) { slot.pending = undefined; reject(error); }
    });
  }

  private worker(slot: WorkerSlot): WorkerHandle {
    if (slot.handle) return slot.handle;
    if (this.closed || slot.job?.canceled || slot.stopping) throw slot.job?.canceled ?? closedError();
    const sourceUrl = this.workerUrl.protocol === "file:" && this.workerUrl.pathname.endsWith(".js")
      ? new URL(this.workerUrl.href.replace(/\.js$/, ".ts")) : undefined;
    const isSourceEntrypoint = this.workerUrl.pathname.endsWith(".ts")
      || Boolean(sourceUrl && !existsSync(fileURLToPath(this.workerUrl)) && existsSync(fileURLToPath(sourceUrl)));
    const execArgv = isSourceEntrypoint ? ["--import", import.meta.resolve("tsx")] : [];
    const worker = new Worker(this.workerUrl, { execArgv });
    let exited!: () => void;
    const handle: WorkerHandle = { worker, exited: new Promise<void>((resolveExit) => { exited = resolveExit; }), expectedStop: false };
    slot.handle = handle;
    this.created += 1;
    worker.on("message", (message: unknown) => {
      const pending = slot.pending;
      if (!pending || pending.handle !== handle) return;
      const response = message as { id?: number; ok?: boolean; prepared?: DocumentPreparedResult; error?: { message?: string } };
      if (!response || response.id !== pending.id || typeof response.ok !== "boolean") {
        void this.stop(slot, workerError()); return;
      }
      if (!response.ok && typeof response.error?.message !== "string") {
        void this.stop(slot, new DocumentExecutorError("DOCUMENT_WORKER_PROTOCOL", "Document worker returned an invalid error response; no write performed."));
        return;
      }
      if (response.ok && (!response.prepared || (response.prepared.kind !== "read" && response.prepared.kind !== "write"))) {
        void this.stop(slot, new DocumentExecutorError("DOCUMENT_WORKER_PROTOCOL", "Document worker returned an invalid preparation; no write performed."));
        return;
      }
      slot.pending = undefined;
      if (response.ok) pending.resolve(response.prepared!);
      else pending.reject(new Error(typeof response.error?.message === "string" ? response.error.message.slice(0, 2_000) : "Document preparation failed."));
    });
    const crashed = (cause?: unknown): void => {
      if (handle.expectedStop || slot.handle !== handle) return;
      this.crashes += 1;
      void this.stop(slot, workerError(cause));
    };
    worker.on("error", crashed);
    worker.once("exit", () => { exited(); crashed(); });
    worker.unref();
    return handle;
  }

  private stop(slot: WorkerSlot, error: Error): Promise<void> {
    if (slot.stopping) return slot.stopping;
    const handle = slot.handle;
    if (!handle) return Promise.resolve();
    handle.expectedStop = true;
    slot.handle = undefined;
    if (slot.pending?.handle === handle) { slot.pending.reject(error); slot.pending = undefined; }
    const stopping = (async () => {
      try { await handle.worker.terminate(); } finally { await handle.exited; }
    })().catch(() => undefined);
    slot.stopping = stopping.finally(() => {
      slot.stopping = undefined;
      this.drain();
    });
    return slot.stopping;
  }

  private settle(job: Job, result: string | undefined, error: unknown): void {
    if (job.stage === "done") return;
    job.stage = "done";
    if (job.timer) clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    job.measurement.total_ms = elapsed(job.enqueuedAt);
    job.measurement.status = !error ? "succeeded" : job.canceled?.name === "AbortError" ? "aborted"
      : job.canceled?.name === "TimeoutError" ? "timed_out" : job.canceled instanceof DocumentExecutorError && job.canceled.code === "DOCUMENT_EXECUTOR_CLOSED" ? "closed" : "failed";
    this.measurements.push({ ...job.measurement });
    if (this.measurements.length > 100) this.measurements.shift();
    this.settled += 1;
    try { this.options.onMeasurement?.({ ...job.measurement }); } catch { /* Diagnostics never change document outcomes. */ }
    if (error) job.reject(error); else job.resolve(result!);
  }
}
