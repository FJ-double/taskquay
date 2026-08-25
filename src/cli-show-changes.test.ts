import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));

test("show-changes prints a Git-backed historical review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-cli-show-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await execFileAsync("git", ["init", project]);
  await git(project, ["config", "user.email", "devspace@example.com"]);
  await git(project, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(project, "README.md"), "hello\n");
  await git(project, ["add", "README.md"]);
  await git(project, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_cli", root: project });
  await writeFile(join(project, "README.md"), "hello\nreview me\n");
  const review = await manager.reviewChanges({ workspaceId: "ws_cli", root: project });

  const configDir = join(root, ".devspace");
  const env = writeTestDevspaceConfig(configDir, {
    workspaces: { allowedRoots: [project] },
    storage: { stateDir: join(root, ".state") },
  });
  const cliArgs = ["--import", tsxLoader, cliPath, "show-changes", review.reviewRef];
  const plain = await execFileAsync("node", cliArgs, {
    cwd: project,
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "",
      DEVSPACE_WORKSPACE_ROOT: "",
    },
    encoding: "utf8",
  });
  assert.match(plain.stdout, /\+review me/);

  const json = await execFileAsync("node", [...cliArgs, "--json"], {
    cwd: project,
    env: {
      ...process.env,
      ...env,
      DEVSPACE_WORKSPACE_ID: "",
      DEVSPACE_WORKSPACE_ROOT: "",
    },
    encoding: "utf8",
  });
  const parsed = JSON.parse(json.stdout) as {
    reviewRef: string;
    patch: string;
  };
  assert.equal(parsed.reviewRef, review.reviewRef);
  assert.equal(parsed.patch, review.patch);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
