import { parentPort } from "node:worker_threads";
import { NativeDocumentProcessor, type DocumentInput } from "./native-documents.js";

if (!parentPort) throw new Error("Document worker must run in a worker thread.");
const port = parentPort;
const processor = new NativeDocumentProcessor();
let busy = false;

port.on("message", async (message: { id: number; path: string; input: DocumentInput; bytes: Uint8Array }) => {
  if (busy) { port.postMessage({ id: message.id, ok: false, error: { message: "Document worker is busy." } }); return; }
  busy = true;
  try {
    const prepared = await processor.prepare(message.path, message.input, message.bytes);
    if (prepared.kind === "write") {
      // A dedicated buffer avoids detaching a pooled Buffer or cache storage.
      const output = Uint8Array.from(prepared.output);
      port.postMessage({ id: message.id, ok: true, prepared: { ...prepared, output } }, [output.buffer]);
    } else port.postMessage({ id: message.id, ok: true, prepared });
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: { message: error instanceof Error ? error.message : "Document preparation failed." } });
  } finally { busy = false; }
});

port.once("close", () => { void processor.close(); });
