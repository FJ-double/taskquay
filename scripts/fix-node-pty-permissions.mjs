import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

if (process.platform === "darwin") {
  // Resolve node-pty the way the runtime does: consumer installs usually
  // hoist it next to this package rather than into our own node_modules.
  let nodePtyRoot;
  try {
    nodePtyRoot = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch (error) {
    // Optional dependency (e.g. --omit=optional): nothing to fix.
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  for (const architecture of nodePtyRoot ? ["arm64", "x64"] : []) {
    const helper = resolve(nodePtyRoot, "prebuilds", `darwin-${architecture}`, "spawn-helper");
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
