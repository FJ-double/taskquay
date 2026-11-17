#!/usr/bin/env node
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, realpathSync, symlinkSync, writeFileSync, chmodSync, unlinkSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin'||process.arch!=='arm64') throw new Error('Build this candidate on macOS arm64. Intel packages are not produced.');
const output=resolve(process.argv[2]??join(root,'releases'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
if(git('status','--porcelain')) throw new Error('Commit the candidate source before packaging so its build SHA identifies the exact source.');
const sourceSha=git('rev-parse','HEAD');
const baselineSha=git('rev-parse','baseline/v1.1.0-bearer');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const work=realpathSync(mkdtempSync(join(tmpdir(),'taskquay-macos-build-')));
const stage=join(work,'source');mkdirSync(stage);
const bundle=join(work,'taskquay-macos-arm64');mkdirSync(bundle);
const env={...process.env,pnpm_config_verify_deps_before_run:'false',COPYFILE_DISABLE:'1'};
function run(command,args,cwd=stage){execFileSync(command,args,{cwd,env,stdio:'inherit'});}
function walk(directory,visitor){for(const e of readdirSync(directory,{withFileTypes:true})){const p=join(directory,e.name);if(e.isDirectory())walk(p,visitor);else visitor(p,e);}}
try {
  for(const name of git('ls-files','-z').split('\0').filter(Boolean)) {const dest=join(stage,name);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,name),dest);}
  // A real staging install keeps peer-dependency links inside the deployed payload.
  run('pnpm',['install','--frozen-lockfile','--offline']);
  run('pnpm',['build']);
  run('pnpm',['--filter','.', 'deploy','--legacy','--prod',join(bundle,'app')]);
  const node=realpathSync(process.execPath);
  mkdirSync(join(bundle,'runtime/bin'),{recursive:true});copyFileSync(node,join(bundle,'runtime/bin/node'));chmodSync(join(bundle,'runtime/bin/node'),0o755);
  copyFileSync(join(dirname(dirname(node)),'LICENSE'),join(bundle,'runtime/LICENSE'));
  run(node,['scripts/fix-node-pty-permissions.mjs'],join(bundle,'app'));
  // Keep the Claude Agent SDK bridge, but use the user's existing Claude Code CLI.
  // The platform-specific SDK binary is otherwise a redundant ~221 MiB copy.
  const packageStore=join(bundle,'app/node_modules/.pnpm');
  const pruned=[];
  const removeFile=(file)=>{if(existsSync(file)){unlinkSync(file);pruned.push(relative(bundle,file));}};
  for(const entry of readdirSync(packageStore)){
    const installed=join(packageStore,entry,'node_modules');
    if(entry.startsWith('@anthropic-ai+claude-agent-sdk-darwin-arm64@')){
      removeFile(join(installed,'@anthropic-ai','claude-agent-sdk-darwin-arm64','claude'));
    }
    if(entry.startsWith('node-pty@')){
      const prebuilds=join(installed,'node-pty','prebuilds');
      for(const target of readdirSync(prebuilds)){
        if(target.startsWith('win32-')){
          rmSync(join(prebuilds,target),{recursive:true,force:true});
          pruned.push(relative(bundle,join(prebuilds,target)));
        }
      }
    }
    if(entry.startsWith('better-sqlite3@')){
      const sqlite=join(installed,'better-sqlite3');
      const build=join(sqlite,'build');
      walk(build,(file,dirent)=>{
        if(!dirent.isSymbolicLink()&&file!==join(build,'Release','better_sqlite3.node'))removeFile(file);
      });
      const sources=join(sqlite,'deps');
      rmSync(sources,{recursive:true,force:true});
      pruned.push(relative(bundle,sources));
    }
  }
  walk(packageStore,(file,dirent)=>{
    if(!dirent.isSymbolicLink()&&file.endsWith('.map'))removeFile(file);
  });
  copyFileSync(join(root,'scripts/install-macos.mjs'),join(bundle,'install.mjs'));
  // Installer resolves its shared JSONC parser through the deployed app dependencies.
  symlinkSync('app/node_modules',join(bundle,'node_modules'));
  writeFileSync(join(bundle,'install.command'),'#!/bin/zsh\nset -eu\nif [[ "$(/usr/bin/uname -m)" != arm64 ]]; then print -u2 "Apple Silicon Mac required"; exit 1; fi\nTASKQUAY_PAYLOAD="${0:A:h}"\nexec "$TASKQUAY_PAYLOAD/runtime/bin/node" "$TASKQUAY_PAYLOAD/install.mjs" "$@"\n',{mode:0o755});
  const removed=[];
  walk(join(bundle,'app/node_modules'),(p,e)=>{
    if(e.isSymbolicLink())return;
    const magic=Buffer.alloc(4); const fd=openSync(p,'r');
    try { readSync(fd,magic,0,4,0); } finally { closeSync(fd); }
    const signature=magic.toString('hex');
    if(!['7f454c46','feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(signature)&&!signature.startsWith('4d5a'))return;
    const kind=execFileSync('/usr/bin/file',['-b',p],{encoding:'utf8'});
    if(/ELF|PE32/.test(kind)||(/Mach-O/.test(kind)&&!kind.includes('arm64'))){removed.push(relative(bundle,p));unlinkSync(p);}
  });
  // A deployable payload must not refer back to the build checkout or pnpm store.
  walk(bundle,(p,e)=>{if(e.isSymbolicLink()){const target=realpathSync(p);const rel=relative(bundle,target);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('External payload symlink: '+relative(bundle,p));}});
  const info={product:'Taskquay',version:pkg.version,platform:'darwin',arch:'arm64',sourceSha,baselineSha,nodeVersion:process.version,builtAt:new Date().toISOString(),externalClaudeCode:true,prunedReleaseFiles:pruned.length,removedForeignBinaries:removed.length};
  writeFileSync(join(bundle,'app/build-info.json'),JSON.stringify(info,null,2)+'\n');
  writeFileSync(join(bundle,'build-info.json'),JSON.stringify(info,null,2)+'\n');
  cpSync(join(root,'docs/macos-arm64.md'),join(bundle,'README.md'));
  mkdirSync(output,{recursive:true});
  const artifact=join(output,`taskquay-macos-arm64-${pkg.version}.tar.gz`);
  run('/usr/bin/tar',['-czf',artifact,'-C',work,'taskquay-macos-arm64'],root);
  const sha256=createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(artifact+'.sha256',`${sha256}  ${artifact.split('/').at(-1)}\n`);
  writeFileSync(artifact+'.json',JSON.stringify({...info,artifact,sha256,removedForeignBinaryPaths:removed},null,2)+'\n');
  console.log(JSON.stringify({artifact,sha256,version:pkg.version,sourceSha}));
} finally {rmSync(work,{recursive:true,force:true});}
