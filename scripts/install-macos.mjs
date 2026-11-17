#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';

process.umask(0o077);
const payload = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args[0] && !args[0].startsWith('--') ? args.shift() : 'install';
const options = new Map();
while (args.length) {
  const key = args.shift(), value = args.shift();
  if (!['--install-root','--config-dir','--label'].includes(key) || !value || options.has(key)) throw new Error('Usage: install.command [install|status|stop|start|rollback] [--install-root path] [--config-dir path] [--label name]');
  options.set(key,value);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.getuid() === 0) throw new Error('Run as the logged-in user on an Apple Silicon Mac. Do not use sudo.');
const root = resolve(options.get('--install-root') ?? join(homedir(),'.local/share/taskquay-macos'));
const config = resolve(options.get('--config-dir') ?? join(homedir(),'.devspace'));
const label = options.get('--label') ?? 'net.taskquay.macos';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(label) || !label.toLowerCase().includes('taskquay')) throw new Error('Use a Taskquay service label.');
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const plistPath = join(homedir(),'Library/LaunchAgents',`${label}.plist`);
const current = join(root,'current');
const previousFile = join(root,`${label}.previous.json`);
const run = (command,args,required=true) => {
  const r=spawnSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(required && r.status!==0) throw new Error(`${command} ${args[0]} failed (${r.status}): ${r.stderr.trim()}`);
  return r;
};
const xml = text => String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const loaded = () => run('/bin/launchctl',['print',target],false).status===0;
async function stop() {
  const service=run('/bin/launchctl',['print',target],false);
  if(service.status!==0) return;
  const pid=Number(/\bpid = (\d+)/.exec(service.stdout)?.[1]);
  run('/bin/launchctl',['bootout',target]);
  // bootout returns before a gracefully draining server has necessarily exited.
  for(let i=0;i<100;i++) {
    let alive=false;
    if(pid) { try { process.kill(pid,0); alive=true; } catch {} }
    if(!loaded()&&!alive) return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('The selected Taskquay service is still stopping; inspect its logs before restarting.');
}
function point(path) {
  const temporary=join(root,`.current-${process.pid}`);
  if(existsSync(temporary)) unlinkSync(temporary);
  symlinkSync(path,temporary);
  renameSync(temporary,current);
}
function plist(release) {
  const environment={DEVSPACE_CONFIG_DIR:config,PATH:[join(release,'runtime/bin'),join(homedir(),'.local/bin'),'/opt/homebrew/bin','/opt/homebrew/sbin',process.env.PATH??'/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),SHELL:process.env.SHELL||'/bin/zsh'};
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(join(release,'runtime/bin/node'))}</string><string>${xml(join(release,'app/dist/cli.js'))}</string><string>serve</string></array>
<key>WorkingDirectory</key><string>${xml(join(release,'app'))}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v])=>`<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(root,'logs',label+'.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root,'logs',label+'.err.log'))}</string>
</dict></plist>\n`;
}
async function healthy(expected) {
  const settings=parse(readFileSync(join(config,'config.jsonc'),'utf8'));
  const host=settings.server?.host;
  const localHost=!host||host==='0.0.0.0'||host==='::'?'127.0.0.1':host.includes(':')?`[${host}]`:host;
  const url=`http://${localHost}:${settings.server?.port??7676}/healthz`;
  for(let i=0;i<40;i++) {
    try {
      const r=await fetch(url,{signal:AbortSignal.timeout(1000)}); const d=await r.json();
      if(r.ok && d.name==='devspace' && d.version===expected.version && d.build_sha===expected.sourceSha) return;
    } catch {}
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error(`Taskquay did not start at ${url}; inspect ${join(root,'logs')}. Existing services on other labels were not stopped.`);
}
async function restore(prior) {
  await stop();
  if(prior.release) point(prior.release);
  else if(existsSync(current)) unlinkSync(current);
  if(prior.plist) { writeFileSync(plistPath,prior.plist,{mode:0o600}); run('/bin/launchctl',['bootstrap',domain,plistPath]); }
  else if(existsSync(plistPath)) unlinkSync(plistPath);
}

try {
  if(action==='status') {
    const release=existsSync(current)?readlinkSync(current):null;
    const info=release?JSON.parse(readFileSync(join(release,'app/build-info.json'),'utf8')):null;
    console.log(JSON.stringify({label,running:loaded(),release,build:info},null,2));
  } else if(action==='stop') { await stop(); console.log('Taskquay stopped.'); }
  else if(action==='start') {
    if(!existsSync(current)) throw new Error('Install a candidate first.');
    if(!loaded()) run('/bin/launchctl',['bootstrap',domain,plistPath]);
    await healthy(JSON.parse(readFileSync(join(readlinkSync(current),'app/build-info.json'),'utf8')));
    console.log('Taskquay started.');
  } else if(action==='rollback') {
    if(!existsSync(previousFile)) throw new Error('No previous installation is recorded.');
    const prior=JSON.parse(readFileSync(previousFile,'utf8'));
    if(!prior.release&&!prior.plist) throw new Error('No previous version exists; use stop for this first installation.');
    await restore(prior); console.log('Previous Taskquay service restored. Configuration and state were retained.');
  } else if(action==='install') {
    const info=JSON.parse(readFileSync(join(payload,'app/build-info.json'),'utf8'));
    if(info.platform!=='darwin'||info.arch!=='arm64'||!/^[a-f0-9]{40}$/.test(info.sourceSha)) throw new Error('Invalid macOS arm64 build metadata.');
    if(!existsSync(join(config,'config.jsonc'))) {
      const init=spawnSync(join(payload,'runtime/bin/node'),[join(payload,'app/dist/cli.js'),'init'],{env:{...process.env,DEVSPACE_CONFIG_DIR:config},stdio:'inherit'});
      if(init.status!==0) throw new Error('Complete local Taskquay initialization before installing the service.');
    }
    mkdirSync(join(root,'releases'),{recursive:true,mode:0o700}); mkdirSync(join(root,'logs'),{recursive:true,mode:0o700});
    mkdirSync(dirname(plistPath),{recursive:true});
    const release=join(root,'releases',`${info.version}-${info.sourceSha.slice(0,12)}`);
    if(!existsSync(release)) cpSync(payload,release,{recursive:true,verbatimSymlinks:true});
    const prior={release:existsSync(current)?readlinkSync(current):null,plist:existsSync(plistPath)?readFileSync(plistPath,'utf8'):null};
    writeFileSync(previousFile,JSON.stringify(prior),{mode:0o600});
    await stop();
    try {
      point(release); writeFileSync(plistPath,plist(release),{mode:0o600});
      run('/bin/launchctl',['bootstrap',domain,plistPath]); await healthy(info);
    } catch(error) { await restore(prior); throw error; }
    console.log(JSON.stringify({installed:true,label,version:info.version,sourceSha:info.sourceSha,release,configDir:config},null,2));
  } else throw new Error('Unknown installer command.');
} catch(error) { console.error(error.message); process.exitCode=1; }
