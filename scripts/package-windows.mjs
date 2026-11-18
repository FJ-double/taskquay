import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile, readdir, rm, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 package on Windows x64.');
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'releases');
const bundle = resolve(output, 'taskquay-windows-x64');
const app = resolve(bundle, 'app');
await rm(bundle, { recursive: true, force: true });
await mkdir(app, { recursive: true });
const run = (cmd, args, cwd = root) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true, shell: /\.cmd$/i.test(cmd) });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${cmd} exited ${result.status}`);
};
for (const path of ['bin','dist','skills','schema','scripts/windows-service-control-broker.ps1','build-info.json','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']) {
  await cp(resolve(root, path), resolve(app, path), { recursive: true });
}
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
delete packageJson.devDependencies; delete packageJson.scripts; delete packageJson.optionalDependencies;
await writeFile(resolve(app, 'package.json'), JSON.stringify(packageJson, null, 2));
run('npm.cmd', ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=true'], app);
await mkdir(resolve(bundle, 'runtime'), { recursive: true });
await cp(process.execPath, resolve(bundle, 'runtime/node.exe'));
const nodeLicense = resolve(root, 'scripts/node-licenses', `node-v${process.versions.node}-LICENSE`);
try { await cp(nodeLicense, resolve(bundle, 'runtime/LICENSE')); }
catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
  if (!response.ok) throw new Error('Unable to include the Node.js runtime license.');
  await writeFile(resolve(bundle, 'runtime/LICENSE'), await response.text());
}
for (const path of ['install-windows.ps1','uninstall-windows.ps1']) await cp(resolve(root, 'scripts', path), resolve(bundle, path));
await writeFile(resolve(bundle, 'taskquay.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\dist\\cli.js" %*\r\n');

// Native packages may ship every OS in one npm tarball. Keep only Windows x64.
let pruned = 0;
async function prune(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (/^(?:darwin|linux|freebsd|openbsd|android|aix|sunos)(?:[-_].*)?$/i.test(entry.name)
      || /^(?:win32|win10|win32-msvc)[-_](?:arm64|ia32|x86)$/.test(entry.name)
      || /\.(?:dylib|so)(?:\.\d+)*$/.test(entry.name) || /\.(?:sh|bash|zsh|c|cc|cpp|cxx|h|hh|hpp|hxx|S|asm|gyp|gypi)$/.test(entry.name)) { await rm(path, { recursive: true, force: true }); pruned++; }
    else if (entry.isDirectory()) await prune(path);
    else if (entry.isFile()) {
      const handle = await open(path, 'r'); const header = Buffer.alloc(4);
      try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
      const magic = header.toString('hex');
      if (['7f454c46','feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca'].includes(magic)) {
        await rm(path); pruned++;
      }
    }
  }
}
await prune(resolve(app, 'node_modules'));
const forbidden = /^(?:@anthropic-ai\/(?:claude-agent-sdk|sandbox-runtime)|@earendil-works\/pi-(?:coding-agent|ai|tui)|@opencode-ai\/sdk|@agentclientprotocol\/sdk)$/;
const lock = JSON.parse(await readFile(resolve(app, 'package-lock.json'), 'utf8'));
const dependencies = Object.keys(lock.packages).filter(path => path && existsSync(resolve(app, path))).map(path => path.split('node_modules/').at(-1));
const sdk = dependencies.filter(name => forbidden.test(name));
if (sdk.length) throw new Error(`Agent SDK found in release: ${sdk.join(', ')}`);
const zip = resolve(output, 'taskquay-windows-x64.zip');
run('tar.exe', ['-a','-cf',zip,'taskquay-windows-x64'], output);
const sha256 = createHash('sha256').update(await readFile(zip)).digest('hex');
const info = { ...JSON.parse(await readFile(resolve(root,'build-info.json'),'utf8')), artifact: "taskquay-windows-x64.zip",
  bytes: (await stat(zip)).size, sha256, prunedForeignResources: pruned, agentSDKs: sdk, dependencies };
await writeFile(zip + '.json', JSON.stringify(info, null, 2));
await writeFile(zip + '.sha256', `${sha256}  taskquay-windows-x64.zip\n`);
console.log(JSON.stringify({ artifact: "taskquay-windows-x64.zip", bytes: info.bytes, sha256, prunedForeignResources: pruned, agentSDKs: sdk }));
