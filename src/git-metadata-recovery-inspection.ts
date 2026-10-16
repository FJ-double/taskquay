import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { GIT_METADATA_GUARD_FILE } from "./windows-git-metadata-mutex.js";

const execFileAsync=promisify(execFile);
export interface GitMetadataRecoveryInspection {
  mode:"observe_only";
  sourceRoot:string;
  inspectedAt:string;
  gitCommonDir:string|null;
  listedWorktrees:number;
  metadataEntries:number;
  consistent:boolean;
  issues:string[];
  operatorAction:"review_only_never_auto_prune";
}

/** Audit the specific repository after native named-mutex abandonment.
 * Even a "consistent" result NEVER releases an orphaned lock, removes a
 * worktree, or authorizes automated replay/repair.
 *
 * No --prune, --repair, --expire, --lost-found or modifying Git commands.
 */
export async function inspectGitMetadataReadonly(sourceRoot:string,
  maxEntries=100):Promise<GitMetadataRecoveryInspection> {
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>500)
    throw new Error("GIT_INSPECTION_BOUND_INVALID");
  const root=realpathSync(sourceRoot);
  const issues:string[]=[];
  let gitCommonDir:string|null=null,listedWorktrees=0,metadataEntries=0;
  const result=():GitMetadataRecoveryInspection=>({
    mode:"observe_only",sourceRoot:root,inspectedAt:new Date().toISOString(),
    gitCommonDir,listedWorktrees,metadataEntries,consistent:issues.length===0,
    issues,operatorAction:"review_only_never_auto_prune",
  });
  try {
    const run=async(args:string[])=> {
      const output=await execFileAsync("git",["-C",root,...args],{
        timeout:5000,maxBuffer:512*1024,
        env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_NO_LAZY_FETCH:"1"},
        windowsHide:true,
      });
      return output.stdout;
    };
    const common=(await run(["rev-parse","--path-format=absolute","--git-common-dir"])).trim();
    gitCommonDir=realpathSync(common);
    if(existsSync(join(gitCommonDir,GIT_METADATA_GUARD_FILE))) {
      issues.push("GIT_METADATA_PENDING_TRANSACTION_NEEDS_REVIEW");
    }
    const listed=await run(["worktree","list","--porcelain"]);
    const sections=listed.split(/\r?\n\r?\n/).filter(Boolean);
    listedWorktrees=sections.length;
    if(sections.length>maxEntries) {
      issues.push("GIT_WORKTREE_LIST_EXCEEDS_BOUND");
      return result();
    }
    for(const block of sections) {
      const path=/^worktree (.+)$/m.exec(block)?.[1];
      if(!path||!existsSync(path))issues.push("LISTED_WORKTREE_PATH_MISSING");
      if(/^prunable(?:\s|$)/m.test(block))issues.push("GIT_WORKTREE_PRUNABLE_NEEDS_REVIEW");
    }
    const metadataRoot=join(gitCommonDir,"worktrees");
    if(!existsSync(metadataRoot))return result();
    const records=readdirSync(metadataRoot,{withFileTypes:true});
    metadataEntries=records.length;
    if(records.length>maxEntries) {
      issues.push("GIT_WORKTREE_METADATA_EXCEEDS_BOUND");
      return result();
    }
    for(const entry of records) {
      if(!entry.isDirectory()) {
        issues.push("GIT_WORKTREE_METADATA_NON_DIRECTORY");
        continue;
      }
      const metadata=join(metadataRoot,entry.name);
      const commondir=join(metadata,"commondir"),gitdir=join(metadata,"gitdir");
      if(!existsSync(commondir)||!existsSync(gitdir)) {
        issues.push("GIT_WORKTREE_METADATA_FILE_MISSING");continue;
      }
      let actualCommon:string;
      try{
        const pointer=readFileSync(commondir,"utf8").trim();
        if(!pointer||pointer.includes("\0"))throw new Error("invalid");
        actualCommon=realpathSync(resolve(metadata,pointer));
      }catch{issues.push("GIT_WORKTREE_COMMONDIR_UNRESOLVED");continue;}
      if(actualCommon.toLowerCase()!==gitCommonDir.toLowerCase()) {
        issues.push("GIT_WORKTREE_COMMONDIR_MISMATCH");
      }
      try {
        const pointer=readFileSync(gitdir,"utf8").trim();
        if(!pointer||pointer.includes("\0"))throw new Error("invalid");
        const worktreeGit=resolve(metadata,pointer);
        if(!statSync(worktreeGit).isFile())throw new Error("invalid");
        const back=readFileSync(worktreeGit,"utf8").trim();
        if(!back.startsWith("gitdir: "))throw new Error("invalid");
        const backPath=resolve(dirname(worktreeGit),back.slice(8).trim());
        if(backPath.toLowerCase()!==metadata.toLowerCase()) {
          issues.push("GIT_WORKTREE_GITDIR_BACKLINK_MISMATCH");
        }
      }catch{issues.push("GIT_WORKTREE_GITDIR_UNRESOLVED");}
    }
  }catch{
    issues.push("GIT_READ_ONLY_INSPECTION_INCOMPLETE");
  }
  return result();
}
