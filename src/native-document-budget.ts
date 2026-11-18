import { DOCUMENT_PAYLOAD_BYTES, documentReply } from "./native-document-replies.js";

/** UTF-8 bytes inside JSON.stringify(text)'s surrounding quotes. */
export function escapedJsonContentBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) bytes += 2;
    else if (unit < 0x20) bytes += 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function jsonContribution(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Document array entries must serialize to JSON values.");
  return escapedJsonContentBytes(encoded);
}

// The result string occupies two JSON string values in this envelope. Empty
// strings retain their four surrounding quotes in the constant overhead.
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify(documentReply("")), "utf8");
const COMPLETION_BYTES = jsonContribution({ complete: true, truncated: false, next_cursor: null }) - 2 + 1;

/**
 * Exact additive budget for a plain result record with one growing array.
 * Entries are serialized individually; accepted entries are never rescanned.
 * The caller must retain its final full encodeDocumentResult validation.
 */
export class DocumentArrayReplyBudget {
  private readonly baseBytes: number;
  private entriesBytes = 0;
  private count = 0;

  constructor(base: Record<string, unknown>, arrayKey: string) {
    const reserved = [arrayKey, "complete", "truncated", "next_cursor"];
    if (["complete", "truncated", "next_cursor"].includes(arrayKey) || reserved.some((key) => Object.hasOwn(base, key))) {
      throw new Error("Document array budget metadata overlaps its array or completion fields.");
    }
    this.baseBytes = jsonContribution({ ...base, [arrayKey]: [] });
  }

  replyBytes(nextCursor: string | null): number {
    // The two booleans always contribute one `true` and one `false`. A null
    // cursor costs four bytes; string cursor contribution includes its quotes.
    const cursorBytes = nextCursor === null ? 0 : jsonContribution(nextCursor) - 4;
    return ENVELOPE_BYTES + 2 * (this.baseBytes + this.entriesBytes + COMPLETION_BYTES + cursorBytes);
  }

  tryAppend(entry: unknown, nextCursor: string | null): boolean {
    const contribution = jsonContribution(entry) + Number(this.count > 0);
    if (this.replyBytes(nextCursor) + 2 * contribution > DOCUMENT_PAYLOAD_BYTES) return false;
    this.entriesBytes += contribution;
    this.count += 1;
    return true;
  }
}
