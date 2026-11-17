import * as z from "zod/v4";
import { documentReply } from "../native-documents.js";
import { NativeDocumentExecutor } from "../native-document-executor.js";
import { NativeDocumentJobs, documentJobCaller } from "../native-document-jobs.js";
import { resultOutputSchema, runLoggedToolOperation } from "./shared.js";
import { workspaceIdDescription } from "./types.js";
const cellValue = z.union([z.string().max(32767), z.number().finite(), z.boolean()]);
const cellEdit = z.object({
    sheet: z.string().optional(),
    cell: z.string().min(2).max(10).describe("A1 address within A1:XFD1048576."),
    value: cellValue,
    expected: z.string().max(131072).optional().describe("Exact old cell value as text, including JSON for formula/rich values."),
});
export function registerNativeDocumentTools({ server, config, workspaces, processSessions }, documents = new NativeDocumentExecutor(), jobs) {
    const manager = jobs ?? new NativeDocumentJobs({ stateDir: config.stateDir });
    if (!jobs) {
        const closeExecutor = documents.close.bind(documents);
        let closing;
        documents.close = () => closing ??= (async () => { await manager.close(); await closeExecutor(); })();
    }
    server.registerTool("document_tool", {
        title: "Native Excel, Word and PDF operations",
        description: "Inspect/search XLSX, DOCX and PDF; edit up to 1000 XLSX cells, DOCX text runs, or append a blank PDF page. Returns existing fast results within about 1 second; slower work continues independently of HTTP disconnection and returns operation_id for status/result/cancel. Use a stable request_key for writes and retry only the same input/key: unknown or interrupted writes require file/backup inspection, never blind replay. Losing the first reply without a request_key can lose the operation_id. Edits create one backup and recheck source SHA before replacement (portable last-check/rename, not atomic CAS). Read pagination and the 48 KiB serialized MCP reply bound remain supported.",
        inputSchema: {
            workspace_id: z.string().describe(workspaceIdDescription),
            action: z.enum(["inspect", "search", "cell_set", "cells_set", "text_replace", "pdf_append_blank", "status", "result", "cancel"]),
            path: z.string().min(1).optional().describe("Existing workspace .xlsx, .docx or .pdf for a new operation; status/result/cancel reauthorize the stored path."),
            operation_id: z.string().regex(/^op_[a-f0-9]{32}$/).optional().describe("Required for status/result/cancel. Results remain bound to the original workspace/root and authenticated caller."),
            request_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/).optional().describe("Recommended stable idempotency key for every write. Same key/input returns the existing operation; changed input conflicts. Keep the same key after a lost reply."),
            wait_ms: z.number().int().min(0).max(1000).optional().describe("Short wait only: default1000ms for new submissions and0ms for queries. HTTP disconnection stops waiting, not the accepted background job."),
            sheet: z.string().optional().describe("XLSX worksheet; defaults to the first sheet for inspect/edits, all sheets for search."),
            cell: z.string().optional(),
            value: cellValue.optional(),
            expected: z.string().max(131072).optional().describe("Optional exact old-cell text expectation for cell_set."),
            edits: z.array(cellEdit).min(1).max(1000).optional().describe("Required for cells_set. Every target, value and expectation is validated before mutation; duplicate sheet/cell targets are rejected. Total edits JSON <=2 MiB."),
            expected_sha256: z.string().regex(/^[a-f\d]{64}$/i).optional().describe("Optional source document SHA-256 precondition. Edits also recheck the loaded source before replacement."),
            find: z.string().max(2000).optional(),
            replacement: z.string().max(2000).optional(),
            paged: z.boolean().optional().describe("XLSX inspect: opt into explicit cells with values or lossless JSON value fragments. Legacy inspect retains rows[].cells=row.values; its cursor continues in cell format."),
            range: z.string().max(21).optional().describe("XLSX inspect/search: A1 cell or A1:B20 rectangle; implies paged cells."),
            cursor: z.string().max(2000).optional().describe("Opaque next_cursor from a prior response. Repeat the same path/action/sheet/range/find/page range; fails if document bytes changed. Concatenate text by codepoint offsets, or JSON value_fragment by cell and then JSON.parse."),
            page_start: z.number().int().min(1).optional().describe("PDF read/search first page (1-based)."),
            page_end: z.number().int().min(1).optional().describe("PDF read/search last page, inclusive; defaults to final page. Inspection emits one page at a time, with text continuation if needed."),
        },
        outputSchema: resultOutputSchema({ durable: z.boolean().describe("Local job/receipt persistence is confirmed; this does not acknowledge host delivery.") }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async ({ workspace_id, operation_id, request_key, wait_ms, ...input }, extra) => {
        const started = performance.now();
        const workspace = await workspaces.getWorkspace(workspace_id);
        const scope = { workspaceId: workspace.id, workspaceRoot: workspace.root, callerId: documentJobCaller(extra) };
        const reply = await runLoggedToolOperation(config, { tool: "document_tool", workspaceId: workspace_id, path: input.path }, started, async () => {
            if (input.action === "status" || input.action === "result" || input.action === "cancel") {
                if (!operation_id)
                    throw new Error("operation_id is required for document status/result/cancel.");
                const stored = await manager.lookup(operation_id, scope);
                // Reauthorize every result/cancel request; a job id or matching OAuth client alone is not path authority.
                await workspaces.resolvePath(workspace, stored.path);
                return manager.query(operation_id, scope, input.action, wait_ms ?? 0, extra.signal);
            }
            if (!input.path)
                throw new Error("path is required for a new document operation.");
            const path = await workspaces.resolvePath(workspace, input.path);
            const args = { ...input, action: input.action, path };
            extra.signal?.throwIfAborted();
            const edit = input.action === "cell_set" || input.action === "cells_set" || input.action === "text_replace" || input.action === "pdf_append_blank";
            return manager.submit({ scope, path, input: args, requestKey: request_key, waitMs: wait_ms, signal: extra.signal }, async (signal, onStage) => {
                const current = await workspaces.getWorkspace(workspace_id);
                if (current.root !== workspace.root)
                    throw new Error("Document workspace root changed before execution.");
                await workspaces.resolvePath(current, path);
                // The claim belongs to the full background execution, not to this short HTTP wait.
                return edit ? processSessions.mutate(current.root, () => documents.execute(path, args, { signal, onStage }))
                    : processSessions.readWorkspace(current.root, () => documents.execute(path, args, { signal, onStage }));
            });
        }, value => ({ success: !value.isError }));
        return { ...documentReply(reply.result), structuredContent: { result: reply.result, operation_id: reply.operationId, durable: reply.durable }, ...(reply.isError ? { isError: true } : {}) };
    });
    return documents;
}
