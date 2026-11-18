import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const files = [];
async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) {
  const child = resolve(path, entry.name); if (entry.isDirectory()) { if (entry.name !== 'ui') await walk(child); }
  else if (entry.name.endsWith('.js')) files.push(child);
} }
await walk(dist);
for (const path of files) {
  const code = await readFile(path, 'utf8');
  const result = await transform(code, { loader: 'js', format: 'esm', target: 'node22', platform: 'node', treeShaking: true,
    minifySyntax: true, define: { 'process.platform': '"win32"', 'process.arch': '"x64"' } });
  await writeFile(path, result.code);
}
// Keep compiled modules reached by public entry points or subprocess/worker URLs.
const keep = new Set();
async function visit(path) {
  if (keep.has(path) || !files.includes(path)) return;
  keep.add(path);
  const code = await readFile(path, 'utf8');
  for (const match of code.matchAll(/["'](\.\.?\/[A-Za-z0-9_./-]+\.js)["']/g)) await visit(resolve(dirname(path), match[1]));
}
for (const entry of ['cli.js', 'server.js', 'local-agent-daemon-main.js', 'execution-runner-child.js', 'provider-turn-child.js', 'native-document-worker.js']) await visit(resolve(dist, entry));
for (const path of files) if (!keep.has(path)) await rm(path);
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
await writeFile(resolve(root, 'build-info.json'), JSON.stringify({ product: 'Taskquay', version, sourceSha,
  baselineSha: 'b681a9b89637f938493f411e9ba05d3ac0fecb73', platform: 'win32', arch: 'x64', agentSDKs: [], builtAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`Windows specialization: ${keep.size} runtime modules; removed ${files.length - keep.size} unreachable modules.`);
