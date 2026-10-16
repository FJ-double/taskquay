import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const win = process.platform === "win32" ? {} : { skip: "Requires native Windows ACLs" };

test("isolated native pipe and directory ACL deny an anonymous OS principal at the kernel boundary", win, () => {
  const script = fileURLToPath(new URL("../scripts/test-windows-anonymous-service-acl.ps1", import.meta.url));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    timeout: 25_000,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env },
  });
  assert.equal(result.status, 0,
    `Native ACL test failed: ${result.error?.message ?? ""} ${result.stderr ?? ""} ${result.stdout ?? ""}`);
  assert.match(result.stdout, /WINDOWS_NATIVE_ANONYMOUS_ACL_OK/);
  assert.match(result.stdout, /pipeDaclCreatedAtomically=True/);
  assert.match(result.stdout, /anonymousTokenPipeError=5/);
  assert.match(result.stdout, /anonymousTokenDirectoryRead=False/);
  assert.match(result.stdout, /currentUserPipeAndDirectoryAccess=True/);
});

test("disposable native pipe DACL denies an OS restricted token but permits the same unrestricted user", win, () => {
  const script = fileURLToPath(new URL("../scripts/test-windows-restricted-token-pipe.ps1", import.meta.url));
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
    timeout: 25_000, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0,
    `Restricted token probe failed: ${result.error?.message ?? ""} ${result.stderr ?? ""}`);
  assert.match(result.stdout, /WINDOWS_NATIVE_RESTRICTED_TOKEN_ACL_OK/);
  assert.match(result.stdout, /originalIdentityOpen=0/);
  assert.match(result.stdout, /restrictedIdentityOpen=5/);
});
