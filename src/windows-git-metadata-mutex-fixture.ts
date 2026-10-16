/** TEST-only independent Windows process holding a named Git metadata mutex. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { withWindowsGitMetadataMutex } from "./windows-git-metadata-mutex.js";

const [key, dir, label] = process.argv.slice(2);
if (process.platform !== "win32" || !key || !dir || !label) process.exit(72);
writeFileSync(join(dir, `ready-${label}`), "ready");
for (let i = 0; !existsSync(join(dir, "go")); i++) {
  if (i > 300) throw new Error("MUTEX_TEST_BARRIER_TIMEOUT");
  await delay(25);
}
await withWindowsGitMetadataMutex(key, async () => {
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({label, event:"enter",at:Date.now()}) + "\n");
  if (label === "crash") {
    // Parent ends ONLY this disposable holder after a competing process
    // has opened the named kernel mutex. No cleanup/prune after killing.
    await new Promise<void>(() => {setInterval(()=>{},1000);});
  }
  await delay(label === "hold" ? 700 : 180);
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify({label, event:"exit",at:Date.now()}) + "\n");
});
