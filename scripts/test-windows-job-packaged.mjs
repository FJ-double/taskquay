import { randomUUID } from "node:crypto";
import { WindowsCommandRunner } from "../dist/execution-runner.js";

if (process.platform !== "win32") {
  console.log("Windows Job packaged probe: skipped on non-Windows.");
  process.exit(0);
}

let output = "";
const runner = await WindowsCommandRunner.start({
  executionId: `ex_${randomUUID().replaceAll("-", "")}`,
  generation: 1,
  command: "echo PACKAGED_JOB_OK",
  cwd: process.cwd(),
  environment: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
  persistArmed: ({ memberCount, runnerCreatedAt, jobIdentity }) => {
    if (memberCount !== 1 || !runnerCreatedAt || !jobIdentity.startsWith("Local\\taskquay-job-")) {
      throw new Error("Packaged Runner was not verifiably Job-armed.");
    }
  },
  onStdout: (chunk) => { output += chunk.toString("utf8"); },
});
try {
  const proof = await runner.finished;
  if (!output.includes("PACKAGED_JOB_OK") || proof.activeProcesses !== 0 || proof.rootExitCode !== 0) {
    throw new Error("Packaged Runner failed the command/proof contract.");
  }
  console.log("PACKAGED_JOB_OK", JSON.stringify({ job: proof.jobIdentity, activeProcesses: proof.activeProcesses }));
} finally {
  await runner.cancel(0);
}
