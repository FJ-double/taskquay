import { open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { documentReply, encodeDocumentResult, fitsDocumentResult, pageDocumentText, pageDocumentTextView } from "./native-document-replies.js";
import { buildDocumentTextIndex, buildJoinedDocumentTextIndex, findDocumentTextCaseInsensitive, sliceDocumentText, sliceJoinedDocumentText } from "./native-document-text.js";
import { DocumentArrayReplyBudget } from "./native-document-budget.js";
import { DocumentSnapshotCache, documentSnapshotBytes } from "./native-document-snapshots.js";
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_DOCX_BYTES = 40 * 1024 * 1024;
const MAX_XML_CHARS = 10_000_000;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
export { documentReply };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isEdit = (action) => ["cell_set", "cells_set", "text_replace", "pdf_append_blank"].includes(action);
/** Bound queued/worker input before cloning it; raw string units are a cheap lower bound on JSON UTF-8 bytes. */
export function validateDocumentInputSize(input) {
    const { edits, ...metadata } = input;
    const scalarUnits = (value, label) => {
        let units = 0;
        for (const [key, child] of Object.entries(value)) {
            if (child !== undefined && child !== null && !["string", "number", "boolean"].includes(typeof child))
                throw new Error(`${label} must contain only scalar fields.`);
            units += key.length + (typeof child === "string" ? child.length : 0);
            if (units > MAX_BATCH_BYTES)
                throw new Error(`${label} exceeds the 2 MiB input limit.`);
        }
        return units;
    };
    scalarUnits(metadata, "Document metadata");
    if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_BATCH_BYTES)
        throw new Error("Document metadata exceeds the 2 MiB input limit.");
    if (edits === undefined)
        return;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 1000)
        throw new Error("edits must contain 1–1000 cell edits.");
    let units = 0;
    for (const edit of edits) {
        if (!edit || typeof edit !== "object" || Array.isArray(edit))
            throw new Error("Every edit requires scalar cell fields.");
        units += scalarUnits(edit, "Cell edits");
        if (units > MAX_BATCH_BYTES)
            throw new Error("Cell edits exceed the 2 MiB input limit.");
    }
    if (Buffer.byteLength(JSON.stringify(edits)) > MAX_BATCH_BYTES)
        throw new Error("Cell edits exceed the 2 MiB input limit.");
}
function escapeXml(value) {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function unescapeXml(value) {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
        if (entity.startsWith("#x"))
            return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity.startsWith("#"))
            return String.fromCodePoint(parseInt(entity.slice(1), 10));
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity] ?? "";
    });
}
function requireNonempty(value, label) {
    if (!value || value.length > 2_000)
        throw new Error(`${label} must be 1–2000 characters.`);
    return value;
}
export async function loadDocumentSource(path, signal) {
    signal?.throwIfAborted();
    const file = await open(path, "r");
    try {
        signal?.throwIfAborted();
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > MAX_DOCUMENT_BYTES)
            throw new Error("Document must be a regular file <= 20 MiB.");
        const chunks = [];
        let total = 0;
        // Reading one extra byte detects growth without allocating the entire growing file.
        while (total <= MAX_DOCUMENT_BYTES) {
            signal?.throwIfAborted();
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DOCUMENT_BYTES + 1 - total));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (!bytesRead)
                break;
            chunks.push(chunk.subarray(0, bytesRead));
            total += bytesRead;
        }
        signal?.throwIfAborted();
        if (total > MAX_DOCUMENT_BYTES || (await file.stat()).size > MAX_DOCUMENT_BYTES)
            throw new Error("Document must be a regular file <= 20 MiB.");
        return Buffer.concat(chunks, total);
    }
    finally {
        await file.close();
    }
}
async function safeReplace(path, bytes, source, sourceHash) {
    if (bytes.length > MAX_DOCUMENT_BYTES)
        throw new Error("Modified document exceeds the 20 MiB limit.");
    const tag = randomUUID();
    const temp = join(dirname(path), `.${basename(path)}.${tag}.tmp`);
    const backup = join(dirname(path), `${basename(path)}.${tag}.bak`);
    let backupCreated = false;
    try {
        await writeFile(temp, bytes, { flag: "wx" });
        // Back up the parsed source, rather than a potentially newer external version.
        await writeFile(backup, source, { flag: "wx" });
        backupCreated = true;
        if (sha256(await loadDocumentSource(path)) !== sourceHash)
            throw new Error("Document changed since read; no write performed.");
        // Portable last-check/rename, not an OS atomic compare-and-swap against external writers.
        await rename(temp, path);
    }
    catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        if (backupCreated)
            await rm(backup, { force: true }).catch(() => undefined);
        throw error;
    }
    return backup;
}
function workbookText(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        return String(value);
    return JSON.stringify(value) ?? "";
}
function cursorScope(path, input) {
    return sha256(JSON.stringify([resolve(path), input.action, input.sheet ?? null, input.range?.toUpperCase() ?? null,
        input.find ?? null, input.page_start ?? null, input.page_end ?? null]));
}
function readCursor(input, sourceHash, scope) {
    if (!input.cursor)
        return {};
    if (input.cursor.length > 2_000)
        throw new Error("Invalid document cursor.");
    let cursor;
    try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    }
    catch {
        throw new Error("Invalid document cursor.");
    }
    if (!cursor || cursor.v !== 1 || cursor.query !== scope || !cursor.position || typeof cursor.position !== "object"
        || Array.isArray(cursor.position))
        throw new Error("Document cursor does not match this path/action/selection.");
    if (cursor.sha256 !== sourceHash)
        throw new Error("Document cursor is stale; inspect the current document again.");
    for (const [key, value] of Object.entries(cursor.position)) {
        if (!["offset", "index", "row", "column", "page"].includes(key) || !Number.isSafeInteger(value) || value < 0)
            throw new Error("Invalid document cursor position.");
    }
    const keys = extname(input.path).toLowerCase() === ".xlsx" ? ["index", "row", "column", "offset"]
        : extname(input.path).toLowerCase() === ".pdf" ? ["page", "offset"] : input.action === "inspect" ? ["offset"] : ["index"];
    if (Object.keys(cursor.position).length !== keys.length || keys.some(key => !(key in cursor.position)))
        throw new Error("Invalid document cursor position.");
    return cursor.position;
}
function makeCursor(sourceHash, scope, position) {
    return Buffer.from(JSON.stringify({ v: 1, sha256: sourceHash, query: scope, position })).toString("base64url");
}
function completion(next) { return { complete: next === null, truncated: next !== null, next_cursor: next }; }
function address(value) {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value);
    if (!match)
        throw new Error("Valid A1 cell address required (A1:XFD1048576).");
    const column = [...match[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    const row = Number(match[2]);
    if (column > 16384 || row > 1048576)
        throw new Error("Cell address exceeds XLSX bounds (XFD1048576).");
    return { row, column, address: `${match[1].toUpperCase()}${row}` };
}
function selection(range, sheet) {
    if (!range)
        return { firstRow: 1, lastRow: sheet.rowCount, firstColumn: 1, lastColumn: Math.min(16384, sheet.columnCount) };
    const pair = range.split(":");
    if (pair.length > 2)
        throw new Error("range must be an A1 cell or A1:B20 rectangle.");
    const start = address(pair[0]);
    const end = address(pair[1] ?? pair[0]);
    if (start.row > end.row || start.column > end.column)
        throw new Error("range end must follow its start.");
    return { firstRow: start.row, lastRow: Math.min(end.row, sheet.rowCount), firstColumn: start.column, lastColumn: end.column };
}
function validateEditValue(edit) {
    if (typeof edit.value !== "string" && typeof edit.value !== "number" && typeof edit.value !== "boolean")
        throw new Error("Cell value must be a string, finite number or boolean.");
    if (typeof edit.value === "number" && !Number.isFinite(edit.value))
        throw new Error("Cell value must be finite.");
    if (typeof edit.value === "string" && edit.value.length > 32767)
        throw new Error("Cell strings must be <= 32767 UTF-16 characters.");
    if (edit.expected !== undefined && (typeof edit.expected !== "string" || edit.expected.length > 131072))
        throw new Error("Cell expected must be a string <= 131072 characters.");
}
/** Project supplementary Unicode text with its sheet/cell/property identity, ignoring unrelated model normalization. */
function nonBmpProjection(workbook) {
    const hash = createHash("sha256");
    let entries = 0;
    const add = (identity, value) => {
        if (typeof value === "string") {
            if (/[\u{10000}-\u{10FFFF}]/u.test(value)) {
                hash.update(JSON.stringify([identity, value]));
                entries++;
            }
        }
        else if (Array.isArray(value)) {
            value.forEach((item, index) => add([...identity, String(index)], item));
        }
        else if (value && typeof value === "object") {
            for (const key of Object.keys(value).sort())
                add([...identity, key], value[key]);
        }
    };
    workbook.worksheets.forEach((sheet, index) => {
        add([String(index), "sheet_name"], sheet.name);
        sheet.eachRow(row => row.eachCell(cell => add([String(index), sheet.name, cell.address], cell.value)));
    });
    return entries ? hash.digest("hex") : null;
}
async function prepareExcelEdit(input, bytes, sourceHash, metrics) {
    if (input.action === "pdf_append_blank")
        throw new Error("pdf_append_blank applies only to PDF.");
    if (input.action === "text_replace")
        throw new Error("Use cell_set or cells_set to edit XLSX; bulk text_replace is unsupported.");
    const parseStart = performance.now();
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    metrics.parse_ms += performance.now() - parseStart;
    const worksheet = input.sheet ? workbook.getWorksheet(input.sheet) : workbook.worksheets[0];
    if (!worksheet)
        throw new Error("Worksheet not found.");
    if (input.action === "cell_set" || input.action === "cells_set") {
        const edits = input.action === "cell_set" ? [{ sheet: input.sheet, cell: input.cell ?? "", value: input.value, expected: input.expected }] : input.edits;
        if (!Array.isArray(edits) || edits.length < 1 || edits.length > 1000)
            throw new Error("edits must contain 1–1000 cell edits.");
        const targets = new Set();
        const checked = edits.map(edit => {
            if (!edit || typeof edit !== "object" || typeof edit.cell !== "string")
                throw new Error("Every edit requires a cell address and value.");
            validateEditValue(edit);
            const sheet = edit.sheet ? workbook.getWorksheet(edit.sheet) : worksheet;
            if (!sheet)
                throw new Error("Worksheet not found.");
            const target = address(edit.cell);
            const key = `${sheet.id}:${target.address}`;
            if (targets.has(key))
                throw new Error("Duplicate cell target in edits; no write performed.");
            targets.add(key);
            const cell = sheet.findCell(target.row, target.column);
            const oldValue = workbookText(cell?.value);
            if (edit.expected !== undefined && oldValue !== edit.expected)
                throw new Error("Cell changed since last read; no write performed.");
            return { sheet, target, oldValue, edit };
        });
        // All values, addresses, duplicate targets and expectations pass before any mutation.
        for (const item of checked)
            item.sheet.getCell(item.target.address).value = item.edit.value;
        const unicodeProjection = nonBmpProjection(workbook);
        const serializeStart = performance.now();
        const output = Buffer.from(await workbook.xlsx.writeBuffer());
        metrics.serialize_ms += performance.now() - serializeStart;
        if (output.length > MAX_DOCUMENT_BYTES)
            throw new Error("Modified document exceeds the 20 MiB limit.");
        if (unicodeProjection) {
            // ExcelJS/JSZip can split a surrogate pair while serializing long XML strings.
            // Verify only documents at risk; ordinary BMP workbooks retain one parse/save.
            const verifyStart = performance.now();
            const verified = new ExcelJS.Workbook();
            await verified.xlsx.load(new Uint8Array(output).buffer);
            metrics.parse_ms += performance.now() - verifyStart;
            if (nonBmpProjection(verified) !== unicodeProjection)
                throw new Error("XLSX Unicode integrity check failed after serialization; no write performed.");
        }
        if (input.action === "cell_set") {
            const item = checked[0];
            return { kind: "write", output, sourceHash, response: { updated: item.target.address, sheet: item.sheet.name, oldValue: item.oldValue, value: item.edit.value } };
        }
        return { kind: "write", output, sourceHash, response: { updated_count: checked.length } };
    }
    throw new Error("Unsupported XLSX edit action.");
}
function excelRow(sheet, row) {
    return "rows" in sheet ? sheet.rows[row] : sheet.getRow(row);
}
function excelCell(row, column) {
    return "cells" in row ? row.cells[column] : row.getCell(column);
}
async function extractExcelView(bytes, budget) {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    const transient = () => ({ format: "xlsx-transient", sheets: workbook.worksheets.map(sheet => ({
            name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
            getRow: rowNumber => {
                const row = sheet.findRow(rowNumber);
                if (!row?.hasValues)
                    return undefined;
                return { cellCount: row.cellCount, getValues: () => row.values, getCell: column => {
                        const cell = row.findCell(column);
                        return !cell || cell.type === ExcelJS.ValueType.Null ? undefined
                            : { address: cell.address, json: JSON.stringify(cell.value), text: workbookText(cell.value) };
                    } };
            },
        })) });
    if (!budget)
        return transient();
    const exceeded = {};
    // Every cached cell needs at least 246 accounted bytes, even with an empty/minimal scalar.
    // This proves large dense projections cannot fit before allocating their strings/records.
    let minimumBytes = 0;
    try {
        for (const sheet of workbook.worksheets)
            sheet.eachRow(row => {
                minimumBytes += row.actualCellCount * 246;
                if (minimumBytes > budget)
                    throw exceeded;
            });
    }
    catch (error) {
        if (error === exceeded)
            return transient();
        throw error;
    }
    let accounted = documentSnapshotBytes({ format: "xlsx", sheets: [] });
    const sheets = [];
    try {
        workbook.worksheets.forEach((sheet, sheetIndex) => {
            const rows = {};
            const projection = { name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount, rows };
            accounted += 24 + String(sheetIndex).length * 2 + documentSnapshotBytes(projection);
            if (accounted > budget)
                throw exceeded;
            sheet.eachRow((row, rowNumber) => {
                const cells = {};
                const projectedRow = { cellCount: row.cellCount, cells };
                accounted += 24 + String(rowNumber).length * 2 + documentSnapshotBytes(projectedRow);
                if (accounted > budget)
                    throw exceeded;
                row.eachCell((cell, column) => {
                    if (typeof cell.value === "string" && accounted + cell.value.length * 4 > budget)
                        throw exceeded;
                    const projected = { address: cell.address, json: JSON.stringify(cell.value), text: workbookText(cell.value) };
                    accounted += 24 + String(column).length * 2 + documentSnapshotBytes(projected);
                    if (accounted > budget)
                        throw exceeded;
                    cells[column] = projected;
                });
                rows[rowNumber] = projectedRow;
            });
            sheets.push(projection);
        });
    }
    catch (error) {
        if (error === exceeded)
            return transient();
        throw error;
    }
    return { format: "xlsx", sheets };
}
function excelRowValues(row) {
    if ("getValues" in row)
        return row.getValues();
    const values = [];
    for (const [column, cell] of Object.entries(row.cells))
        values[Number(column)] = JSON.parse(cell.json);
    return values;
}
function readExcelSnapshot(workbook, input, sourceHash, scope, position, encode) {
    const worksheet = input.sheet ? workbook.sheets.find(sheet => sheet.name === input.sheet) : workbook.sheets[0];
    if (!worksheet)
        throw new Error("Worksheet not found.");
    const sheets = input.action === "search" && !input.sheet ? workbook.sheets : [worksheet];
    const firstSelection = selection(input.range, sheets[0]);
    const base = input.action === "inspect"
        ? { source_sha256: sourceHash, sheets: workbook.sheets.map(s => s.name), activeSheet: worksheet.name, rowCount: worksheet.rowCount }
        : { source_sha256: sourceHash, query: requireNonempty(input.find, "find") };
    const nextCursor = (index, row, column, offset = 0) => makeCursor(sourceHash, scope, { index, row, column, offset });
    // Preserve the original small-result row.values shape. Continuations opt into explicit cell records.
    if (input.action === "inspect" && !input.paged && !input.range && !input.cursor) {
        const rows = [];
        const budget = new DocumentArrayReplyBudget({ ...base, format: "rows" }, "rows");
        let next = null;
        for (let n = 1; n <= worksheet.rowCount; n++) {
            const row = excelRow(worksheet, n);
            if (!row)
                continue;
            const candidate = { row: n, cells: excelRowValues(row) };
            const following = n < worksheet.rowCount ? nextCursor(0, n + 1, 1) : null;
            if (!budget.tryAppend(candidate, following)) {
                next = nextCursor(0, n, 1);
                break;
            }
            rows.push(candidate);
            if (rows.length >= 40) {
                next = following;
                break;
            }
        }
        return encode({ ...base, format: "rows", rows, ...completion(next) });
    }
    let index = position.index ?? 0;
    let rowNumber = position.row ?? firstSelection.firstRow;
    let column = position.column ?? firstSelection.firstColumn;
    let offset = position.offset ?? 0;
    if (index >= sheets.length || rowNumber < 1 || column < 1 || column > 16385 || rowNumber > 1048577)
        throw new Error("Invalid XLSX cursor position.");
    const initialBounds = selection(input.range, sheets[index]);
    if (rowNumber < initialBounds.firstRow || rowNumber > Math.max(initialBounds.firstRow, initialBounds.lastRow + 1)
        || column < initialBounds.firstColumn || column > Math.max(initialBounds.firstColumn, initialBounds.lastColumn + 1)
        || (offset > 0 && (rowNumber > initialBounds.lastRow || column > initialBounds.lastColumn)))
        throw new Error("XLSX cursor position is outside the selected range.");
    const key = input.action === "search" ? "matches" : "cells";
    const entries = [];
    const outputBase = input.action === "inspect" ? { ...base, format: "cells", range: input.range ?? null } : base;
    const budget = new DocumentArrayReplyBudget(outputBase, key);
    const find = input.action === "search" ? input.find.toLowerCase() : undefined;
    let next = null;
    outer: for (; index < sheets.length; index++) {
        const sheet = sheets[index];
        const bounds = selection(input.range, sheet);
        for (; rowNumber <= bounds.lastRow; rowNumber++, column = bounds.firstColumn) {
            const row = excelRow(sheet, rowNumber);
            if (!row) {
                if (offset)
                    throw new Error("Invalid XLSX fragment cursor.");
                continue;
            }
            for (; column <= Math.min(bounds.lastColumn, row.cellCount); column++) {
                const cell = excelCell(row, column);
                if (!cell) {
                    if (offset)
                        throw new Error("Invalid XLSX fragment cursor.");
                    continue;
                }
                const value = input.action === "search" ? cell.text : JSON.parse(cell.json);
                if (find && !cell.text.toLowerCase().includes(find)) {
                    if (offset)
                        throw new Error("Invalid XLSX fragment cursor.");
                    continue;
                }
                const identity = { sheet: sheet.name, cell: cell.address };
                const following = nextCursor(index, rowNumber, column + 1);
                const full = { ...identity, value };
                if (!offset && budget.tryAppend(full, following)) {
                    entries.push(full);
                }
                else if (entries.length && !offset) {
                    next = nextCursor(index, rowNumber, column);
                    break outer;
                }
                else {
                    const encoded = input.action === "search" ? JSON.stringify(cell.text) : cell.json;
                    const fragment = pageDocumentText(encoded, offset, (text, end, total) => {
                        const more = end < total ? nextCursor(index, rowNumber, column, end) : following;
                        return { ...outputBase, [key]: [...entries, { ...identity, value_encoding: "json", value_fragment: text,
                                    value_offset: offset, value_end: end, value_codepoints: total, value_complete: end === total }], ...completion(more) };
                    });
                    // A fragment page always terminates here, allowing exact reconstruction by cell/address.
                    return encode(fragment);
                }
                offset = 0;
                if (entries.length >= (input.action === "search" ? 60 : 200)) {
                    next = following;
                    break outer;
                }
            }
        }
        rowNumber = index + 1 < sheets.length ? selection(input.range, sheets[index + 1]).firstRow : 1;
        column = index + 1 < sheets.length ? selection(input.range, sheets[index + 1]).firstColumn : 1;
    }
    return encode({ ...outputBase, [key]: entries, ...completion(next) });
}
function docxParts(zip) {
    return Object.keys(zip.files).filter(name => name === "word/document.xml" || /^word\/(header|footer)\d+\.xml$/.test(name));
}
function xmlText(xml) {
    if (xml.length > MAX_XML_CHARS)
        throw new Error("Document XML is too large.");
    return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => unescapeXml(m[1])).join("");
}
function checkedDocxParts(zip) {
    let expandedBytes = 0;
    // Check ZIP metadata before inflating XML, then check the actual decoded bytes too.
    for (const [name, file] of Object.entries(zip.files)) {
        if (!name.endsWith(".xml"))
            continue;
        const size = file._data?.uncompressedSize;
        if (size !== undefined)
            expandedBytes += size;
        if (expandedBytes > MAX_EXPANDED_DOCX_BYTES)
            throw new Error("Expanded DOCX XML exceeds 40 MiB.");
    }
    const result = new Map();
    let actualBytes = 0;
    for (const part of docxParts(zip)) {
        const xml = zip.file(part).asText();
        actualBytes += Buffer.byteLength(xml);
        if (xml.length > MAX_XML_CHARS || actualBytes > MAX_EXPANDED_DOCX_BYTES)
            throw new Error("Expanded DOCX XML is too large.");
        result.set(part, xml);
    }
    if (!result.has("word/document.xml"))
        throw new Error("Invalid DOCX: missing word/document.xml.");
    return result;
}
async function extractWordSnapshot(bytes) {
    const { default: PizZip } = await import("pizzip");
    const zip = new PizZip(bytes);
    const parts = checkedDocxParts(zip);
    const extracted = [...parts].map(([name, xml]) => { const text = xmlText(xml); return { name, text, index: buildDocumentTextIndex(text) }; });
    return { format: "docx", parts: extracted, textIndex: buildJoinedDocumentTextIndex(extracted) };
}
function readWordSnapshot(snapshot, input, sourceHash, scope, position, encode) {
    const parts = snapshot.parts.map(part => part.name);
    if (input.action === "inspect") {
        const offset = position.offset ?? 0;
        return encode(pageDocumentTextView({ codepoints: snapshot.textIndex.codepoints,
            slice: (start, end) => sliceJoinedDocumentText(snapshot.parts, snapshot.textIndex, start, end) }, offset, (page, end, total) => ({ source_sha256: sourceHash, parts, text: page,
            text_start: offset, text_end: end, text_codepoints: total, ...completion(end < total ? makeCursor(sourceHash, scope, { offset: end }) : null) })));
    }
    const find = requireNonempty(input.find, "find");
    if (input.action === "search") {
        const hits = [];
        let next = null;
        const start = position.index ?? 0;
        if (start > parts.length)
            throw new Error("Invalid DOCX cursor position.");
        for (let i = start; i < parts.length; i++) {
            if (!snapshot.parts[i].text.includes(find))
                continue;
            const following = i + 1 < parts.length ? makeCursor(sourceHash, scope, { index: i + 1 }) : null;
            if (!fitsDocumentResult({ source_sha256: sourceHash, query: find, parts: [...hits, parts[i]], ...completion(following) })) {
                if (!hits.length)
                    throw new Error("Document metadata exceeds the response limit.");
                next = makeCursor(sourceHash, scope, { index: i });
                break;
            }
            hits.push(parts[i]);
            if (hits.length >= 60) {
                next = following;
                break;
            }
        }
        return encode({ source_sha256: sourceHash, query: find, parts: hits, ...completion(next) });
    }
    throw new Error("Unsupported DOCX read action.");
}
async function prepareWordEdit(input, bytes, sourceHash, metrics) {
    if (input.action !== "text_replace")
        throw new Error(input.action === "pdf_append_blank" ? "pdf_append_blank applies only to PDF." : "cell_set/cells_set apply only to XLSX.");
    const parseStart = performance.now();
    const { default: PizZip } = await import("pizzip");
    const zip = new PizZip(bytes);
    const xmlParts = checkedDocxParts(zip);
    metrics.parse_ms += performance.now() - parseStart;
    const find = requireNonempty(input.find, "find");
    if (input.replacement === undefined || input.replacement.length > 2_000)
        throw new Error("replacement is required, <= 2000 characters.");
    let count = 0;
    for (const [part, xml] of xmlParts) {
        const changed = xml.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (_all, start, value, end) => {
            const decoded = unescapeXml(value);
            if (!decoded.includes(find))
                return start + value + end;
            count += decoded.split(find).length - 1;
            return start + escapeXml(decoded.replaceAll(find, input.replacement)) + end;
        });
        if (changed !== xml)
            zip.file(part, changed);
    }
    if (count === 0)
        throw new Error("Text not found in an individual DOCX text run. Split-run replacements are not applied.");
    const serializeStart = performance.now();
    const output = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
    metrics.serialize_ms += performance.now() - serializeStart;
    return { kind: "write", output, sourceHash, response: { replacements: count, warning: "Edits preserve XML outside matching text runs; verify layout in Word." } };
}
async function preparePDFEdit(input, bytes, sourceHash, metrics) {
    if (input.action !== "pdf_append_blank")
        throw new Error("PDF in-place editing is not supported; use a PDF-specific page workflow.");
    const parseStart = performance.now();
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(new Uint8Array(bytes));
    pdf.addPage();
    metrics.parse_ms += performance.now() - parseStart;
    const serializeStart = performance.now();
    const output = Buffer.from(await pdf.save());
    metrics.serialize_ms += performance.now() - serializeStart;
    return { kind: "write", output, sourceHash, response: { pages: pdf.getPageCount() } };
}
async function readPDFPages(input, sourceHash, scope, position, pages, getPageText, encode) {
    const start = input.page_start ?? 1, end = input.page_end ?? pages;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > pages)
        throw new Error("PDF page range must be within the document's 1-based pages.");
    const pageNumber = position.page ?? start;
    if (pageNumber < start || pageNumber > end)
        throw new Error("Invalid PDF cursor page.");
    const find = input.action === "search" ? requireNonempty(input.find, "find") : undefined;
    for (let n = pageNumber; n <= end; n++) {
        const { text, index } = await getPageText(n);
        const offset = n === pageNumber ? position.offset ?? 0 : 0;
        if (find) {
            if (offset > index.codepoints)
                throw new Error("Invalid PDF cursor offset.");
            const match = findDocumentTextCaseInsensitive(text, index, offset, find);
            if (!match)
                continue;
            const matchStart = match.start, after = match.end;
            const excerpt = sliceDocumentText(text, index, Math.max(0, matchStart - 120), Math.min(index.codepoints, after + 300));
            const next = after < index.codepoints ? makeCursor(sourceHash, scope, { page: n, offset: after })
                : n < end ? makeCursor(sourceHash, scope, { page: n + 1, offset: 0 }) : null;
            return encode({ source_sha256: sourceHash, pages: pages, page: n, found: true, excerpt, match_start: matchStart, match_end: after,
                ...completion(next) });
        }
        return encode(pageDocumentText(text, offset, (page, finish, total) => ({ source_sha256: sourceHash, pages: pages,
            page: n, page_start: start, page_end: end, text: page, text_start: offset, text_end: finish, text_codepoints: total,
            ...completion(finish < total ? makeCursor(sourceHash, scope, { page: n, offset: finish })
                : n < end ? makeCursor(sourceHash, scope, { page: n + 1, offset: 0 }) : null) }), index));
    }
    return encode({ source_sha256: sourceHash, pages: pages, found: false, excerpt: "", ...completion(null) });
}
export class NativeDocumentProcessor {
    snapshots;
    closed = false;
    constructor(options = {}) { this.snapshots = new DocumentSnapshotCache(options); }
    cached(key, metrics) {
        const value = this.snapshots.get(key);
        if (value === undefined)
            metrics.cache_misses++;
        else
            metrics.cache_hits++;
        return value;
    }
    retain(key, value) { if (!this.closed)
        this.snapshots.set(key, value); }
    async snapshot(key, metrics, extract) {
        const cached = this.cached(key, metrics);
        if (cached !== undefined)
            return cached;
        const started = performance.now();
        const value = await extract();
        metrics.parse_ms += performance.now() - started;
        this.retain(key, value);
        return value;
    }
    async excelView(key, metrics, bytes) {
        const cached = this.snapshots.get(key);
        if (cached?.format === "xlsx") {
            metrics.cache_hits++;
            return cached;
        }
        metrics.cache_misses++;
        const started = performance.now();
        const view = await extractExcelView(bytes, cached?.format === "xlsx-bypass" ? 0 : this.snapshots.maxEntryDataBytes(key));
        metrics.parse_ms += performance.now() - started;
        // Bypass hints are tiny immutable data, bounded by the same count/byte/TTL policy.
        this.retain(key, view.format === "xlsx" ? view : { format: "xlsx-bypass" });
        return view;
    }
    /** Pure preparation: all input bytes come from the host; no filesystem reads or writes occur here. */
    async prepare(path, input, source) {
        if (this.closed)
            throw new Error("Native document processor is closed.");
        validateDocumentInputSize(input);
        const ext = extname(path).toLowerCase();
        input = { ...input, path };
        if (![".xlsx", ".docx", ".pdf"].includes(ext))
            throw new Error("Supported document extensions: .xlsx, .docx, .pdf.");
        if (source.byteLength > MAX_DOCUMENT_BYTES)
            throw new Error("Document must be a regular file <= 20 MiB.");
        if (input.expected_sha256 !== undefined && !/^[a-f\d]{64}$/i.test(input.expected_sha256))
            throw new Error("expected_sha256 must be a 64-character SHA-256 hex digest.");
        if (isEdit(input.action) && input.cursor)
            throw new Error("Read cursors cannot be used for document edits.");
        if (ext !== ".xlsx" && (input.range !== undefined || input.paged !== undefined))
            throw new Error("range/paged apply only to XLSX.");
        if (ext !== ".pdf" && (input.page_start !== undefined || input.page_end !== undefined))
            throw new Error("page_start/page_end apply only to PDF.");
        const metrics = { hash_ms: 0, parse_ms: 0, serialize_ms: 0, cache_hit: false,
            cache_bytes: 0, cache_entries: 0, cache_hits: 0, cache_misses: 0 };
        // Own the bytes while asynchronous parsers run; caller mutation cannot change a hashed snapshot.
        const bytes = Buffer.from(source);
        const hashStart = performance.now();
        const sourceHash = sha256(bytes);
        metrics.hash_ms = performance.now() - hashStart;
        if (input.expected_sha256 && input.expected_sha256.toLowerCase() !== sourceHash)
            throw new Error("Document SHA-256 changed; no write performed.");
        const scope = cursorScope(path, input);
        const position = readCursor(input, sourceHash, scope);
        let prepared;
        if (isEdit(input.action)) {
            // A cached readonly projection is never suitable as an editable workbook/ZIP/PDF.
            prepared = ext === ".xlsx" ? await prepareExcelEdit(input, bytes, sourceHash, metrics)
                : ext === ".docx" ? await prepareWordEdit(input, bytes, sourceHash, metrics) : await preparePDFEdit(input, bytes, sourceHash, metrics);
            if (prepared.kind === "write" && prepared.output.byteLength > MAX_DOCUMENT_BYTES)
                throw new Error("Modified document exceeds the 20 MiB limit.");
        }
        else {
            const encode = value => {
                const started = performance.now();
                const result = encodeDocumentResult(value);
                metrics.serialize_ms += performance.now() - started;
                return result;
            };
            let result;
            if (ext === ".xlsx")
                result = readExcelSnapshot(await this.excelView("xlsx:" + sourceHash, metrics, bytes), input, sourceHash, scope, position, encode);
            else if (ext === ".docx")
                result = readWordSnapshot(await this.snapshot("docx:" + sourceHash, metrics, () => extractWordSnapshot(bytes)), input, sourceHash, scope, position, encode);
            else {
                let pdf;
                const ensurePDF = async () => {
                    if (!pdf) {
                        const started = performance.now();
                        const { getDocumentProxy } = await import("unpdf");
                        pdf = await getDocumentProxy(new Uint8Array(bytes));
                        metrics.parse_ms += performance.now() - started;
                    }
                    return pdf;
                };
                try {
                    const metadataKey = "pdf:" + sourceHash + ":meta";
                    let metadata = this.cached(metadataKey, metrics);
                    if (!metadata) {
                        metadata = { pages: (await ensurePDF()).numPages };
                        this.retain(metadataKey, metadata);
                    }
                    result = await readPDFPages(input, sourceHash, scope, position, metadata.pages, async (page) => {
                        const key = "pdf:" + sourceHash + ":page:" + page;
                        const cached = this.cached(key, metrics);
                        if (cached)
                            return cached;
                        const document = await ensurePDF();
                        const started = performance.now();
                        const content = await (await document.getPage(page)).getTextContent();
                        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("");
                        const indexed = { text, index: buildDocumentTextIndex(text) };
                        metrics.parse_ms += performance.now() - started;
                        this.retain(key, indexed);
                        return indexed;
                    }, encode);
                }
                finally {
                    if (pdf)
                        await pdf.loadingTask.destroy();
                }
            }
            prepared = { kind: "read", result };
            metrics.cache_hit = metrics.cache_hits > 0 && metrics.cache_misses === 0;
        }
        const stats = this.snapshots.stats();
        metrics.cache_bytes = stats.bytes;
        metrics.cache_entries = stats.entries;
        return { ...prepared, metrics };
    }
    close() { this.closed = true; this.snapshots.clear(); }
}
/** Host-only write boundary. Preparation may run in a worker; finalization never uses a parser/cache. */
export async function finalizeDocumentOperation(path, prepared, source) {
    if (prepared.kind === "read")
        return prepared.result;
    if (source.length > MAX_DOCUMENT_BYTES || sha256(source) !== prepared.sourceHash)
        throw new Error("Prepared document does not match its source bytes; no write performed.");
    const output = Buffer.from(prepared.output);
    if (output.length > MAX_DOCUMENT_BYTES)
        throw new Error("Modified document exceeds the 20 MiB limit.");
    const currentHash = sha256(output);
    const response = (backup) => {
        const full = { ...prepared.response, source_sha256: prepared.sourceHash, current_sha256: currentHash, backup };
        if (fitsDocumentResult(full))
            return encodeDocumentResult(full);
        if (typeof full.updated === "string" && typeof full.sheet === "string")
            return encodeDocumentResult({ updated: full.updated, sheet: full.sheet,
                values_included: false, source_sha256: prepared.sourceHash, current_sha256: currentHash, backup });
        return encodeDocumentResult(full);
    };
    // Validate the exact-length backup path before a write, so oversized response metadata cannot fail after replacement.
    response(join(dirname(path), basename(path) + ".00000000-0000-0000-0000-000000000000.bak"));
    const backup = await safeReplace(path, output, source, prepared.sourceHash);
    return response(backup);
}
const defaultDocumentProcessor = new NativeDocumentProcessor();
export async function operateDocument(path, input) {
    const source = await loadDocumentSource(path);
    const prepared = await defaultDocumentProcessor.prepare(path, input, source);
    return finalizeDocumentOperation(path, prepared, source);
}
