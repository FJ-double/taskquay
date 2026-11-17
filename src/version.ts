import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("DevSpace package version is missing.");
}

export const DEVSPACE_VERSION = packageJson.version;

export const DEVSPACE_BUILD_SHA: string = (() => {
  try {
    const info = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8")) as { sourceSha?: string };
    return typeof info.sourceSha === "string" ? info.sourceSha : "development";
  } catch { return "development"; }
})();
