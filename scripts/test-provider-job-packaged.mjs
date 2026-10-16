import { randomUUID } from "node:crypto";
import { WindowsProviderTurnRunner } from "../dist/provider-turn-runner.js";

if (process.platform !== "win32") {
  console.log("Packaged provider Job smoke is Windows-only.");
  process.exit(0);
}
// Use a deliberately non-existent Provider. This validates bundled bootstrap,
// isolation and safe rejection with ZERO paid model requests.
const provider = "__packaged_probe_unknown__";
const runner = await WindowsProviderTurnRunner.start({
  executionId: `ex_${randomUUID().replaceAll("-", "")}`,
  generation: 1,
  provider,
  context: { agentId: "packaged-probe", provider, workspaceRoot: process.cwd() },
  input: { prompt: "NOT_SENT_TO_A_MODEL", workspaceRoot: process.cwd() },
  persistArmed: (proof) => {
    if (!proof.jobIdentity.startsWith("Local\\taskquay-job-") ||
        !proof.runnerCreatedAt || proof.runnerPid <= 0) {
      throw new Error("Packaged provider runner is not Job-armed.");
    }
  },
  callbacks: {
    onRequest: () => { throw new Error("UNEXPECTED_PROVIDER_REQUEST"); },
  },
});
const result = await runner.finished;
if (result.ok || result.proof.activeProcesses !== 0 ||
    result.error?.code !== "PROVIDER_ISOLATED_ERROR" ||
    !result.error?.message.includes("Unknown Provider adapter")) {
  throw new Error(`Bundled provider Job probe did not fail closed: ${JSON.stringify(result)}`);
}
console.log("PACKAGED_PROVIDER_JOB_OK", JSON.stringify({
  job: result.proof.jobIdentity,
  activeProcesses: result.proof.activeProcesses,
  modelRequests: 0,
}));
