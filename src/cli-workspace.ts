import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";

export interface CliWorkspaceContext {
  workspaceId?: string;
  workspaceRoot: string;
}

/** Resolve the project boundary used by agent commands from any local harness. */
export function resolveCliWorkspaceContext(
  allowedRoots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CliWorkspaceContext {
  const injectedRoot = env.DEVSPACE_WORKSPACE_ROOT?.trim();
  const candidate = injectedRoot
    ? resolve(injectedRoot)
    : findGitRoot(cwd) ?? resolve(cwd);

  return {
    workspaceId: env.DEVSPACE_WORKSPACE_ID?.trim() || undefined,
    workspaceRoot: assertAllowedPath(candidate, [...allowedRoots]),
  };
}

function findGitRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const root = result.stdout.trim();
  return root ? resolve(root) : undefined;
}
