import type { ToolMode } from "../config.js";
import { codexInstructions, registerCodexTools } from "./codex.js";
import { registerStandardTools, standardInstructions } from "./standard.js";
import { type ToolSurface } from "./types.js";

const TOOL_SURFACES: Record<ToolMode, ToolSurface> = {
  minimal: {
    register: (context) => registerStandardTools(context, "minimal"),
    instructions: standardInstructions("minimal"),
  },
  full: {
    register: (context) => registerStandardTools(context, "full"),
    instructions: standardInstructions("full"),
  },
  codex: {
    register: registerCodexTools,
    instructions: codexInstructions,
  },
};

export function getToolSurface(mode: ToolMode): ToolSurface {
  return TOOL_SURFACES[mode];
}
