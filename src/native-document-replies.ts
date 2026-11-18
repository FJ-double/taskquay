import { buildDocumentTextIndex, documentTextOffset, type DocumentTextIndex, type DocumentTextView } from "./native-document-text.js";

/** The tool's result string is duplicated in content and structuredContent. */
export const MAX_DOCUMENT_REPLY_BYTES = 48 * 1024;
// Leave room for small SDK-added metadata when measuring a received tool result.
export const DOCUMENT_PAYLOAD_BYTES = MAX_DOCUMENT_REPLY_BYTES - 256;
export function documentReply(result: string) {
  return { content: [{ type: "text" as const, text: result }], structuredContent: { result } };
}
export function documentReplyBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(documentReply(JSON.stringify(value))), "utf8");
}
export function fitsDocumentResult(value: Record<string, unknown>): boolean {
  return documentReplyBytes(value) <= DOCUMENT_PAYLOAD_BYTES;
}
export function encodeDocumentResult(value: Record<string, unknown>): string {
  if (!fitsDocumentResult(value)) throw new Error("Document metadata exceeds the 48 KiB serialized MCP response limit.");
  return JSON.stringify(value);
}
/** Build a maximal, well-formed codepoint fragment against the actual reply envelope. */
export function pageDocumentText<T extends Record<string, unknown>>(text: string, offset: number,
  makeResult: (fragment: string, end: number, total: number) => T, index: DocumentTextIndex = buildDocumentTextIndex(text)): T {
  const start = documentTextOffset(text, index, offset);
  return pageDocumentTextView({ codepoints: index.codepoints,
    slice: (_start, end) => text.slice(start, documentTextOffset(text, index, end)) }, offset, makeResult);
}
/** Page a logical text view, including multipart documents, without materializing its entire text. */
export function pageDocumentTextView<T extends Record<string, unknown>>(view: DocumentTextView, offset: number,
  makeResult: (fragment: string, end: number, total: number) => T): T {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > view.codepoints) throw new Error("Invalid document text cursor offset.");
  if (offset === view.codepoints) {
    const result = makeResult("", offset, view.codepoints);
    if (!fitsDocumentResult(result)) throw new Error("Document metadata exceeds the 48 KiB serialized MCP response limit.");
    return result;
  }
  let lo = 0, hi = Math.min(view.codepoints - offset, MAX_DOCUMENT_REPLY_BYTES);
  while (lo < hi) {
    const count = Math.ceil((lo + hi) / 2);
    if (fitsDocumentResult(makeResult(view.slice(offset, offset + count), offset + count, view.codepoints))) lo = count;
    else hi = count - 1;
  }
  if (!lo) throw new Error("Document metadata leaves no room for text within the 48 KiB response limit.");
  return makeResult(view.slice(offset, offset + lo), offset + lo, view.codepoints);
}
