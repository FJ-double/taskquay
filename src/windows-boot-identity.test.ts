import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { windowsBootIdentity } from "./windows-boot-identity.js";

test("native kernel boot identity is stable in parent and independent process", {
  skip: process.platform !== "win32" || process.arch !== "x64" ? "Windows x64 only" : undefined,
}, () => {
  const first = windowsBootIdentity();
  const second = windowsBootIdentity();
  assert.equal(first, second);
  assert.match(first, /^win-ntboot-v1:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{16}$/);
  const child = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--input-type=module", "-e",
    "import { windowsBootIdentity } from " + JSON.stringify(new URL("./windows-boot-identity.ts", import.meta.url).href) +
      "; process.stdout.write(windowsBootIdentity());",
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, first, "identity must match across processes in same boot");
});
