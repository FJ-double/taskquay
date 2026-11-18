/** Compact immutable Unicode positioning data; retained only with its bounded document snapshot. */
export interface DocumentTextIndex {
  readonly utf16Length: number;
  readonly codepoints: number;
  readonly firstPair: number;
  readonly stride: number;
  readonly checkpoints: readonly number[];
}
export interface IndexedDocumentText { readonly text: string; readonly index: DocumentTextIndex }
export interface JoinedDocumentTextIndex { readonly codepoints: number; readonly starts: readonly number[] }
export interface DocumentTextView { readonly codepoints: number; slice(start: number, end: number): string }
const INDEX_STRIDE = 1024;
const pairWidth = (text: string, at: number): number => {
  const high = text.charCodeAt(at), low = text.charCodeAt(at + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
};
export function buildDocumentTextIndex(text: string): DocumentTextIndex {
  const firstPair = text.search(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
  const checkpoints: number[] = [];
  let codepoints = text.length;
  if (firstPair >= 0) {
    let at = firstPair; codepoints = firstPair; checkpoints.push(at);
    while (at < text.length) {
      at += pairWidth(text, at); codepoints++;
      if ((codepoints - firstPair) % INDEX_STRIDE === 0 && at < text.length) checkpoints.push(at);
    }
    // A single pair shifts every following offset by exactly one; no checkpoints are needed.
    if (text.length - codepoints === 1) checkpoints.length = 0;
  }
  return Object.freeze({ utf16Length: text.length, codepoints, firstPair, stride: INDEX_STRIDE, checkpoints: Object.freeze(checkpoints) });
}
function validOffset(offset: number, total: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error("Invalid document text cursor offset.");
}
/** Same boundaries as the JS string iterator/Array.from, including individual unpaired surrogates. */
export function documentTextOffset(text: string, index: DocumentTextIndex, offset: number): number {
  validOffset(offset, index.codepoints);
  if (index.utf16Length !== text.length) throw new Error("Document text index does not match its text.");
  if (offset === index.codepoints) return text.length;
  if (index.firstPair < 0 || offset <= index.firstPair) return offset;
  if (index.utf16Length - index.codepoints === 1) return offset + 1;
  const block = Math.floor((offset - index.firstPair) / index.stride);
  let at = index.checkpoints[block], point = index.firstPair + block * index.stride;
  while (point < offset) { at += pairWidth(text, at); point++; }
  return at;
}
export function sliceDocumentText(text: string, index: DocumentTextIndex, start: number, end: number): string {
  if (end < start) throw new Error("Invalid document text range.");
  return text.slice(documentTextOffset(text, index, start), documentTextOffset(text, index, end));
}
export function buildJoinedDocumentTextIndex(parts: readonly IndexedDocumentText[]): JoinedDocumentTextIndex {
  const starts: number[] = []; let codepoints = 0;
  parts.forEach((part, i) => { starts.push(codepoints); codepoints += part.index.codepoints + (i + 1 < parts.length ? 1 : 0); });
  return Object.freeze({ codepoints, starts: Object.freeze(starts) });
}
/** Slice the logical parts.join("\n") without constructing the full joined text. */
export function sliceJoinedDocumentText(parts: readonly IndexedDocumentText[], index: JoinedDocumentTextIndex, start: number, end: number): string {
  validOffset(start, index.codepoints); validOffset(end, index.codepoints);
  if (end < start) throw new Error("Invalid document text range.");
  if (start === end) return "";
  let lo = 0, hi = index.starts.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (index.starts[mid] <= start) lo = mid + 1; else hi = mid; }
  let result = "";
  for (let i = Math.max(0, lo - 1); i < parts.length && index.starts[i] < end; i++) {
    const part = parts[i], partStart = index.starts[i], partEnd = partStart + part.index.codepoints;
    if (start < partEnd) result += sliceDocumentText(part.text, part.index, Math.max(0, start - partStart), Math.min(part.index.codepoints, end - partStart));
    if (i + 1 < parts.length && start <= partEnd && end > partEnd) result += "\n";
  }
  return result;
}
/** Preserve whole-string contextual lowercasing while mapping matched UTF-16 positions back to source codepoints. */
export function findDocumentTextCaseInsensitive(text: string, index: DocumentTextIndex, offset: number, find: string): { start: number; end: number } | null {
  let atSource = documentTextOffset(text, index, offset);
  const loweredFind = find.toLowerCase(), at = text.slice(atSource).toLowerCase().indexOf(loweredFind);
  if (at < 0) return null;
  let loweredOffset = 0, start = offset;
  while (atSource < text.length) {
    const width = pairWidth(text, atSource), length = text.slice(atSource, atSource + width).toLowerCase().length;
    if (loweredOffset + length > at) break;
    loweredOffset += length; atSource += width; start++;
  }
  let end = start;
  while (atSource < text.length && loweredOffset < at + loweredFind.length) {
    const width = pairWidth(text, atSource); loweredOffset += text.slice(atSource, atSource + width).toLowerCase().length;
    atSource += width; end++;
  }
  return { start, end };
}
