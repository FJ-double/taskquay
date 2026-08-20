import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";

const root = mkdtempSync(join(tmpdir(), "devspace-cli-workspace-test-"));
try {
  const repository = join(root, "repository");
  const nested = join(repository, "packages", "app");
  const plainDirectory = join(root, "plain");
  mkdirSync(nested, { recursive: true });
  mkdirSync(plainDirectory);
  execFileSync("git", ["init", "--quiet", repository]);

  assert.deepEqual(resolveCliWorkspaceContext([root], {}, nested), {
    workspaceId: undefined,
    workspaceRoot: resolve(repository),
  });

  assert.deepEqual(resolveCliWorkspaceContext([root], {}, plainDirectory), {
    workspaceId: undefined,
    workspaceRoot: resolve(plainDirectory),
  });

  assert.deepEqual(resolveCliWorkspaceContext([root], {
    DEVSPACE_WORKSPACE_ID: "ws_injected",
    DEVSPACE_WORKSPACE_ROOT: nested,
  }, plainDirectory), {
    workspaceId: "ws_injected",
    workspaceRoot: resolve(nested),
  });

  assert.throws(
    () => resolveCliWorkspaceContext([repository], {
      DEVSPACE_WORKSPACE_ROOT: plainDirectory,
    }, nested),
    /outside allowed roots/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
