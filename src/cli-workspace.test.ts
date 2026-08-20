import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  // Git returns canonical paths, while macOS and Windows temp directories may
  // be reported through aliases such as /var or an 8.3 short path.
  const allowedRoot = realpathSync(root);
  const repositoryRoot = realpathSync(repository);
  const nestedRoot = realpathSync(nested);
  const plainRoot = realpathSync(plainDirectory);

  assert.deepEqual(resolveCliWorkspaceContext([allowedRoot], {}, nestedRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(repositoryRoot),
  });

  assert.deepEqual(resolveCliWorkspaceContext([allowedRoot], {}, plainRoot), {
    workspaceId: undefined,
    workspaceRoot: resolve(plainRoot),
  });

  assert.deepEqual(resolveCliWorkspaceContext([allowedRoot], {
    DEVSPACE_WORKSPACE_ID: "ws_injected",
    DEVSPACE_WORKSPACE_ROOT: nestedRoot,
  }, plainRoot), {
    workspaceId: "ws_injected",
    workspaceRoot: resolve(nestedRoot),
  });

  assert.throws(
    () => resolveCliWorkspaceContext([repositoryRoot], {
      DEVSPACE_WORKSPACE_ROOT: plainRoot,
    }, nestedRoot),
    /outside allowed roots/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
