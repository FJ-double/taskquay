import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  devspaceConfigJsonSchema,
} from "../src/config-schema.js";

const outputPath = resolve("schema/v1/devspace.schema.json");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(devspaceConfigJsonSchema(), null, 2)}\n`);
