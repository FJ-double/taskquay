/** Immutable extracted document data only; never store a workbook, ZIP, PDF proxy or source bytes here. */
export interface DocumentSnapshotCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}
export type ImmutableDocumentData<T> = T extends readonly (infer U)[] ? readonly ImmutableDocumentData<U>[]
  : T extends object ? { readonly [K in keyof T]: ImmutableDocumentData<T[K]> } : T;
interface Entry { value: unknown; bytes: number; expires: number }
const DEFAULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ENTRIES = 32;
const DEFAULT_TTL_MS = 120_000;
/** Conservative deterministic JS-data accounting, not measured heap allocation or process RSS. */
export function documentSnapshotBytes(value: unknown, limit = Number.MAX_SAFE_INTEGER): number {
  const seen = new WeakSet<object>();
  const size = (item: unknown): number => {
    if (typeof item === "string") return 24 + item.length * 2;
    if (typeof item === "number") return 8;
    if (typeof item === "boolean" || item === null) return 4;
    if (!item || typeof item !== "object") throw new Error("Document snapshots must contain plain immutable data.");
    if (seen.has(item)) throw new Error("Document snapshot data must be an acyclic tree.");
    seen.add(item);
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error("Document snapshots must contain plain immutable data.");
    let bytes = Array.isArray(item) ? 32 : 40;
    for (const [key, child] of Object.entries(item)) {
      bytes += 24 + key.length * 2 + size(child);
      if (bytes > limit) break;
    }
    return bytes;
  };
  return size(value);
}
function freezeTree(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}
export class DocumentSnapshotCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(options: DocumentSnapshotCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (![this.maxBytes, this.maxEntries, this.ttlMs].every(n => Number.isSafeInteger(n) && n >= 0))
      throw new Error("Document snapshot limits must be nonnegative safe integers.");
  }
  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.delete(key);
  }
  private delete(key: string): void {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes; }
  }
  get<T>(key: string): ImmutableDocumentData<T> | undefined {
    this.expire();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value as ImmutableDocumentData<T>;
  }
  maxEntryDataBytes(key: string): number {
    return this.maxEntries && this.ttlMs ? Math.max(0, this.maxBytes - 112 - key.length * 2) : 0;
  }
  set<T>(key: string, value: T): boolean {
    this.expire(); this.delete(key);
    if (!this.maxBytes || !this.maxEntries || !this.ttlMs) return false;
    const bytes = 112 + key.length * 2 + documentSnapshotBytes(value, this.maxBytes);
    if (bytes > this.maxBytes) return false;
    freezeTree(value);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, expires: this.now() + this.ttlMs }); this.bytes += bytes;
    return true;
  }
  stats(): { bytes: number; entries: number } { this.expire(); return { bytes: this.bytes, entries: this.entries.size }; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
