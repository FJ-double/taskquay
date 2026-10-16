import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep, resolve } from "node:path";
import { tmpdir } from "node:os";

export interface ExperimentalServiceHostConfig {
  testOnly: true;
  stateDir: string; workspaceRoot: string; stateRoot: string;
  serviceKey: string; port: number; command: string;
}

const isDescendant = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};

/** Deliberately incapable of selecting production Taskquay paths or
 * arbitrary executables. A real deployable service host requires a new
 * explicitly authorized configuration/ACL design, not deletion of this gate.
 */
export function readIsolatedServiceHostConfig(path: string): ExperimentalServiceHostConfig {
  if (process.env.TASKQUAY_SERVICE_HOST_FIXTURE !== "1") {
    throw new Error("SERVICE_HOST_NOT_ENABLED");
  }
  if (!isAbsolute(path)) throw new Error("SERVICE_HOST_CONFIG_MUST_BE_ABSOLUTE");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (!raw || raw.testOnly !== true) throw new Error("SERVICE_HOST_TEST_ONLY_MARKER_REQUIRED");
  const keys = ["stateDir","workspaceRoot","stateRoot","serviceKey","port","command","testOnly"];
  if (Object.keys(raw).some((key) => !keys.includes(key))) {
    throw new Error("SERVICE_HOST_CONFIG_UNKNOWN_PROPERTY");
  }
  for (const key of ["stateDir","workspaceRoot","stateRoot"]) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key])) {
      throw new Error("SERVICE_HOST_ABSOLUTE_ROOT_REQUIRED");
    }
  }
  const tempRoot=realpathSync(tmpdir()).toLowerCase();
  const configRoot=realpathSync(path);
  if (!isDescendant(tempRoot, configRoot.toLowerCase())) {
    throw new Error("SERVICE_HOST_TEST_CONFIG_OUTSIDE_TEMP");
  }
  const stateDir=realpathSync(raw.stateDir as string);
  const workspaceRoot=realpathSync(raw.workspaceRoot as string);
  const stateRoot=realpathSync(raw.stateRoot as string);
  const roots=[stateDir,workspaceRoot,stateRoot].map((s)=>s.toLowerCase());
  if (roots.some((s)=>!isDescendant(tempRoot,s)) ||
      roots.some((a,i)=>roots.some((b,j)=>i!==j && (a===b ||
        isDescendant(a,b) || isDescendant(b,a))))) {
    throw new Error("SERVICE_HOST_TEST_ROOTS_NOT_ISOLATED");
  }
  if (typeof raw.serviceKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(raw.serviceKey) ||
      !Number.isInteger(raw.port) || (raw.port as number)<1 ||
      (raw.port as number)>65535) {
    throw new Error("SERVICE_HOST_CONFIG_ID_OR_PORT_INVALID");
  }
  // The test host accepts a single Node executable and a single script
  // inside the disposable checkout. No shell flags or command chaining.
  if (typeof raw.command !== "string" || raw.command.length>2048) {
    throw new Error("SERVICE_HOST_COMMAND_NOT_ALLOWED");
  }
  const match=/^"([^"]+)" "([^"]+)"$/.exec(raw.command);
  if (!match || resolve(match[1]).toLowerCase()!==resolve(process.execPath).toLowerCase() ||
      !/\.(?:cjs|js)$/i.test(match[2])) {
    throw new Error("SERVICE_HOST_COMMAND_NOT_ALLOWED");
  }
  const script=realpathSync(match[2]);
  if (!isDescendant(workspaceRoot.toLowerCase(),script.toLowerCase())) {
    throw new Error("SERVICE_HOST_COMMAND_SCRIPT_OUTSIDE_CHECKOUT");
  }
  return {testOnly:true,stateDir,workspaceRoot,stateRoot,
    serviceKey:raw.serviceKey,port:raw.port as number,command:raw.command};
}
