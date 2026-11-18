import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";
import { createTwoFilesPatch } from "diff";
import { resolveShellCommand } from "./process-platform.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<T = unknown> = { content: Content[]; details?: T; isError?: boolean }
interface Context { cwd: string }
const text = (value: string): ToolResponse => ({ content: [{ type: "text", text: value }] });
async function attempt<T>(operation: () => Promise<ToolResponse<T>>): Promise<ToolResponse<T>> {
  try { return await operation(); } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
}
export function readFileTool(input: { path: string; offset?: number; limit?: number }, context: Context): Promise<ToolResponse> {
  return attempt(async () => {
    const path = resolve(context.cwd, input.path);
    const bytes = await readFile(path);
    const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extname(path).toLowerCase()];
    if (mime) { if (bytes.length > 10 * 1024 * 1024) throw new Error("Image exceeds 10 MiB."); return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: mime }] }; }
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("Binary file: use document_tool for XLSX/DOCX/PDF.");
    const lines = bytes.toString("utf8").split("\n");
    const offset = input.offset ?? 1;
    if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be a positive line number.");
    const end = Math.min(lines.length, offset - 1 + (input.limit ?? 2000));
    const selected: string[] = []; let size = 0; let next = offset;
    for (let i = offset - 1; i < end; i++) { const line = lines[i]!; const length = Buffer.byteLength(line) + 1; if (size + length > 40 * 1024) {
      if (!selected.length) {
        const bytes = Buffer.from(line); let end = Math.min(bytes.length, 40 * 1024);
        while (end && !isUtf8(bytes.subarray(0, end))) end--;
        return text(bytes.subarray(0, end).toString("utf8") + `\n[Line ${i + 1} is truncated. Use workspace_context capture with line_offset to read the remaining text.]`);
      }
      break;
    } selected.push(line); size += length; next = i + 2; }
    return text(selected.join("\n") + (next <= lines.length ? `\n[Showing lines ${offset}-${next - 1} of ${lines.length}. Continue with offset=${next}.]` : ""));
  });
}
export function writeFileTool(input: { path: string; content: string }, context: Context): Promise<ToolResponse> {
  return attempt(async () => { const path = resolve(context.cwd, input.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, input.content); return text(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`); });
}
export function editFileTool(input: { path: string; edits: Array<{ oldText: string; newText: string }> }, context: Context): Promise<ToolResponse<{ diff: string; patch: string; firstChangedLine: number }>> {
  return attempt(async () => {
    const path = resolve(context.cwd, input.path); const original = await readFile(path, "utf8");
    const edits = input.edits.map(edit => {
      if (!edit.oldText) throw new Error("oldText must not be empty.");
      const start = original.indexOf(edit.oldText);
      if (start < 0 || original.indexOf(edit.oldText, start + 1) >= 0) throw new Error("oldText must match exactly one region of the original file.");
      return { ...edit, start, end: start + edit.oldText.length };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) if (edits[i]!.start < edits[i - 1]!.end) throw new Error("Edit regions overlap.");
    let updated = original; for (const edit of [...edits].reverse()) updated = updated.slice(0, edit.start) + edit.newText + updated.slice(edit.end);
    await writeFile(path, updated);
    const diff = createTwoFilesPatch(input.path, input.path, original, updated);
    return { content: [{ type: "text", text: diff }], details: { diff, patch: diff, firstChangedLine: original.slice(0, edits[0]?.start ?? 0).split("\n").length } };
  });
}
export function runShellTool(input: { command: string; timeout?: number }, context: Context): Promise<ToolResponse> {
  return attempt(async () => { const shell = resolveShellCommand(input.command); const result = await promisify(execFile)(shell.executable, shell.args,
    { cwd: context.cwd, windowsHide: true, timeout: Math.min(input.timeout ?? 30, 300) * 1000, maxBuffer: 1024 * 1024 }); return text(result.stdout + result.stderr); });
}
