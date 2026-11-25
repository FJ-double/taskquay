import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

const source = resolve(import.meta.dirname, '..');
const app = resolve(process.argv[2] ?? source);
const requireApp = createRequire(join(app, 'package.json'));
const moduleFrom = name => import(pathToFileURL(join(app, 'dist', name + '.js')).href);
const root = join(source, '.acceptance', Date.now().toString());
const project = join(root, 'project');
const report = { installation: process.argv[2] ? 'installed archive' : 'source build', platform: process.platform, arch: process.arch, checks: [], tools: [], agents: [] };
const record = (label, details = {}) => { report.checks.push({ label, outcome: 'passed', ...details }); console.log('PASS ' + label); };
let running, http, store;
try {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  await mkdir(project, { recursive: true }); await writeFile(join(project, 'fixture.txt'), 'Windows acceptance fixture\n');
  execFileSync('git', ['init', '--quiet', project], { windowsHide: true });
  const { defaultDevspaceConfig } = await moduleFrom('config-schema');
  const { writeDevspaceConfig, writeDevspaceAuth } = await moduleFrom('user-config');
  const { loadConfig } = await moduleFrom('config');
  const { createServer } = await moduleFrom('server');
  const { StaticTokenStore } = await moduleFrom('static-token-store');
  const { discoverHostAgents, HostAgentBridge } = await moduleFrom('host-agents');
  const { resolveShellCommand } = await moduleFrom('process-platform');
  const { windowsJobObjectsSupported } = await moduleFrom('windows-job-object');
  const { windowsBootIdentity } = await moduleFrom('windows-boot-identity');
  const { canonicalExecutionRoot } = await moduleFrom('execution-coordinator');
  const { WorkLedger } = await moduleFrom('work-ledger');
  const configDir = join(root, 'config'); const stateDir = join(root, 'state');
  const owner = randomBytes(32).toString('hex');
  const env = { DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_OAUTH_OWNER_TOKEN: owner };
  const stored = defaultDevspaceConfig();
  stored.server.publicBaseUrl = 'http://127.0.0.1:17676'; stored.server.port = 17676;
  stored.workspaces.allowedRoots = [project]; stored.workspaces.worktreeRoot = join(root, 'worktrees');
  stored.storage.stateDir = stateDir; stored.logging.level = 'silent'; stored.tools.mode = 'codex';
  stored.staticTokens.enabled = true; stored.skills.enabled = false; stored.artifacts.enabled = false;
  report.agents = discoverHostAgents().map(agent => ({ id: agent.id, installed: agent.installed }));
  assert(discoverHostAgents({ PATH: '', USERPROFILE: join(root, 'no-agents'), APPDATA: root, LOCALAPPDATA: root }).every(agent => !agent.installed));
  record('No installed agents: empty discovery with installation guidance');
  const selected = report.agents.find(agent => agent.id === 'claude' && agent.installed);
  const fixtureAgent = process.env.TASKQUAY_TEST_AGENT_FIXTURE === '1';
  const hostAgentBridge = fixtureAgent ? new HostAgentBridge({ id: 'claude', installed: true, command: process.execPath,
    args: [join(source, 'scripts', 'windows-agent-fixture.mjs'), join(app, 'package.json')], install: '' }) : undefined;
  report.agentBackend = fixtureAgent ? 'stdio fixture' : selected ? 'installed Claude CLI' : 'unavailable';
  stored.subagents.enabled = Boolean(selected);
  stored.subagents.providers = selected ? [{ id: selected.id, enabled: true }] : [];
  // A configured missing backend must not be advertised.
  stored.windowsMcp = { ...stored.windowsMcp, enabled: true, command: join(root, 'missing-windows-mcp.exe') };
  stored.blenderMcp = { ...stored.blenderMcp, enabled: true, command: join(root, 'missing-blender.exe') };
  writeDevspaceConfig(stored, env); writeDevspaceAuth({ ownerToken: owner }, env);
  const config = loadConfig(env);
  running = createServer(config, { incomingArtifactAdapters: [], registerProject: async () => undefined, hostAgentBridge });
  http = running.app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const base = `http://127.0.0.1:${http.address().port}`;
  assert.equal((await fetch(base + '/healthz')).status, 200); record('Candidate /healthz = 200');
  store = new StaticTokenStore(stateDir);
  const grant = ['open_workspace','read','workspace_context','work_task','exec_command','write_stdin','terminal_sessions','system_processes','recover_tasks','document_tool','agent_task','apply_patch','show_changes','agent_mcp','windows_mcp','blender_mcp'];
  const full = store.create({ name: 'acceptance-full', allowedTools: grant });
  const restricted = store.create({ name: 'acceptance-read', allowedTools: ['read','windows_mcp','blender_mcp','download_artifact'] });
  const rpc = async (token, method, params = {}) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'mcp-method': method, 'mcp-protocol-version': '2026-07-28', ...(params.name ? { 'mcp-name': params.name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(6).toString('hex'), method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'windows-acceptance', version: '1' } } } }) });
    const body = await res.json(); return { status: res.status, body };
  };
  const call = async (name, args) => {
    const response = await rpc(full.token, 'tools/call', { name, arguments: args });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert(!response.body.error && !response.body.result?.isError, `${name}: ${JSON.stringify(response.body)}`);
    return response.body.result;
  };
  const data = result => result.structuredContent ?? JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  const tools = await rpc(full.token, 'tools/list'); assert.equal(tools.status, 200);
  report.tools = tools.body.result.tools.map(tool => tool.name);
  assert(!report.tools.includes('windows_mcp') && !report.tools.includes('blender_mcp') && !report.tools.includes('download_artifact'));
  for (const name of ['document_tool','terminal_sessions','system_processes','recover_tasks','exec_command','write_stdin','read']) assert(report.tools.includes(name));
  record('Bearer tools/list intersects available capabilities and grants');
  const limited = await rpc(restricted.token, 'tools/list'); assert.deepEqual(limited.body.result.tools.map(tool => tool.name), ['read']);
  const denied = await rpc(restricted.token, 'tools/call', { name: 'system_processes', arguments: {} });
  assert(denied.status === 403 || denied.body.error || denied.body.result?.isError); record('Restricted Bearer hides unavailable/ungranted tools and rejects calls');
  // Exercise the existing OAuth owner approval + PKCE exchange.
  const redirect = 'http://127.0.0.1/callback'; const resource = new URL('/mcp', config.publicBaseUrl).href;
  const verifier = randomBytes(48).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url');
  const registration = await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Windows acceptance', redirect_uris: [redirect], grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201); const client = await registration.json();
  const approval = await fetch(base + '/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', scope: 'devspace', resource, state: 'acceptance', owner_token: owner }) });
  assert.equal(approval.status, 302); const code = new URL(approval.headers.get('location')).searchParams.get('code');
  const exchange = await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource }) });
  assert.equal(exchange.status, 200); const oauth = await exchange.json();
  assert.equal((await rpc(oauth.access_token, 'tools/list')).status, 200); record('OAuth owner approval + PKCE + authenticated MCP request');
  const opened = data(await call('open_workspace', { path: project })); const workspaceId = opened.workspace_id;
  assert(workspaceId, JSON.stringify(opened));
  assert(JSON.stringify(await call('read', { workspace_id: workspaceId, path: 'fixture.txt' })).includes('Windows acceptance fixture'));
  record('Workspace open and read');
  await writeFile(join(project, 'long-line.txt'), 'LONG_LINE_BEGIN ' + '測'.repeat(20000));
  const longRead = await call('read', { workspace_id: workspaceId, path: 'long-line.txt' });
  let longText = longRead.structuredContent.result;
  let next = longRead.structuredContent.response_page.next_offset;
  while (next !== null) {
    const page = await call('read', { workspace_id: workspaceId, path: 'long-line.txt', response_offset: next });
    longText += page.structuredContent.result;
    const continuation = page.structuredContent.response_page.next_offset;
    assert(continuation === null || continuation > next); next = continuation;
  }
  assert(longText.startsWith('LONG_LINE_BEGIN') && longText.includes('line_offset'));
  record('Long UTF-8 line returns usable text and a continuation instruction');
  const run = data(await call('work_task', { workspace_id: workspaceId, action: 'begin', work_item_id: 'windows-acceptance', run_key: 'test', title: 'Windows acceptance' }));
  const runId = run.workRunId;
  const shell = resolveShellCommand('', process.platform, process.env, process.platform === 'win32');
  const powerShell = /pwsh(?:\.exe)?$/i.test(shell.executable);
  report.shell = powerShell ? 'PowerShell 7' : 'CMD';
  const command = powerShell ? "Write-Output 'WINDOWS_SHELL_OK'" : 'echo WINDOWS_SHELL_OK';
  const executed = data(await call('exec_command', { workspace_id: workspaceId, work_run_id: runId, request_key: 'shell-once', cmd: command, tty: true }));
  assert(JSON.stringify(executed).includes('WINDOWS_SHELL_OK'));
  assert.equal(executed.execution.shell, shell.executable); assert.equal(executed.execution.transport, 'pipe'); assert.equal(executed.execution.pty_capability, 'pipe_fallback');
  record('PowerShell 7/CMD command; actual shell and pipe fallback', { shell: report.shell });
  assert(windowsJobObjectsSupported()); record('Windows x64 native Job Objects available');
  const longCommand = powerShell ? 'Start-Sleep -Seconds 45' : 'ping -n 46 127.0.0.1 >NUL';
  const long = data(await call('exec_command', { workspace_id: workspaceId, work_run_id: runId, request_key: 'long-once', cmd: longCommand, yield_time_ms: 50 }));
  assert(long.running && long.session_id);
  const liveClaim = data(await call('recover_tasks', { workspace_id: workspaceId, action: 'inspect' })).items[0];
  assert.equal(liveClaim.status, 'active');
  assert.equal(data(await call('recover_tasks', { workspace_id: workspaceId, action: 'recover', claim_id: liveClaim.claimId })).items[0].status, 'active');
  record('Recovery leaves a live Job and its command claim held');
  const sessions = data(await call('terminal_sessions', { workspace_id: workspaceId, action: 'list' }));
  assert(JSON.stringify(sessions).includes(String(long.session_id)));
  await call('terminal_sessions', { workspace_id: workspaceId, action: 'terminate', session_id: long.session_id });
  const ended = data(await call('write_stdin', { workspace_id: workspaceId, session_id: long.session_id, execution_id: long.execution_id, yield_time_ms: 1000 }));
  assert.equal(ended.running, false); record('Owned terminal session list, Job tree termination and terminal receipt');
  const legacyRun = data(await call('work_task', { workspace_id: workspaceId, action: 'begin', work_item_id: 'legacy-recovery', run_key: 'previous-boot', title: 'Isolated legacy lock' }));
  const claimId = 'claim_' + randomBytes(16).toString('hex');
  const bootTicks = BigInt('0x' + windowsBootIdentity().split(':').at(-1));
  const acquired = Number((bootTicks - 116444736000000000n) / 10000n) - 60_000;
  const ledger = new WorkLedger(stateDir);
  const checkoutRoot = canonicalExecutionRoot(project);
  const projectId = ledger.project(checkoutRoot).id;
  let operationId;
  try {
    operationId = ledger.operation({ runId: legacyRun.workRunId, requestKey: 'command:legacy-no-replay', kind: 'command', label: 'Isolated legacy command', status: 'running' });
    ledger.db.prepare(`insert into execution_claims(id,owner_id,owner_pid,kind,checkout_root,resources,acquired_at,access_mode)
      values (?, 'isolated-fixture', 2147483000, 'command', ?, '[]', ?, 'write')`)
      .run(claimId, checkoutRoot, new Date().toISOString());
  } finally { ledger.close(); }
  const blockedRead = await rpc(full.token, 'tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'fixture.txt' } });
  assert(blockedRead.body.result?.isError || blockedRead.body.error);
  const recoveryArgs = { workspace_id: workspaceId, action: 'recover', claim_id: claimId };
  const recoveryDenied = await rpc(restricted.token, 'tools/call', { name: 'recover_tasks', arguments: recoveryArgs });
  assert(recoveryDenied.status === 403 || recoveryDenied.body.error || recoveryDenied.body.result?.isError);
  const past = new WorkLedger(stateDir);
  try {
    past.db.transaction(() => {
      past.db.prepare('update console_operations set created_at=? where id=?').run(new Date(acquired + 2).toISOString(), operationId);
      past.db.prepare('update execution_claims set acquired_at=? where id=?').run(new Date(acquired).toISOString(), claimId);
    }).immediate();
  } finally { past.close(); }
  assert.equal(data(await call('recover_tasks', { ...recoveryArgs, action: 'inspect' })).items[0].status, 'candidate');
  assert.equal(data(await call('recover_tasks', recoveryArgs)).items[0].status, 'released');
  const recoveredRun = data(await call('work_task', { workspace_id: workspaceId, action: 'get', work_run_id: legacyRun.workRunId }));
  assert(JSON.stringify(recoveredRun).includes(operationId));
  assert.equal(recoveredRun.executionStatus, 'failed');
  const consoleLogin = await fetch(base + '/console/api/login', { method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: owner }) });
  assert.equal(consoleLogin.status, 200);
  const cookie = consoleLogin.headers.get('set-cookie').split(';')[0];
  const { csrf } = await consoleLogin.json();
  const consoleRecovery = (csrfToken = '') => fetch(base + `/console/api/projects/${projectId}/recover-command`, { method: 'POST',
    headers: { cookie, origin: base, 'x-devspace-csrf': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ claimId }) });
  assert.equal((await consoleRecovery()).status, 403);
  assert.equal((await (await consoleRecovery(csrf)).json()).items[0].status, 'released');
  record('Local project console recovery requires authenticated CSRF and is idempotent');
  const afterRecovery = data(await call('exec_command', { workspace_id: workspaceId, work_run_id: runId, request_key: 'after-recovery', cmd: command }));
  assert.equal(afterRecovery.exit_code, 0);
  assert.equal(data(await call('recover_tasks', { workspace_id: workspaceId, action: 'inspect' })).items.length, 0);
  record('Legacy lock blocks read, scoped recovery settles the interrupted run, and a new real MCP command exits 0');
  const processes = data(await call('system_processes', { filter: 'node', limit: 20 }));
  assert(JSON.stringify(processes).toLowerCase().includes('node')); record('tasklist.exe process names and PIDs');
  const ExcelJS = requireApp('exceljs'); const PizZip = requireApp('pizzip'); const { PDFDocument } = requireApp('pdf-lib');
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Sheet1').getCell('A1').value = 'XLSX fixture'; await workbook.xlsx.writeFile(join(project, 'sample.xlsx'));
  const zip = new PizZip(); zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture</w:t></w:r></w:p></w:body></w:document>'); await writeFile(join(project, 'sample.docx'), zip.generate({ type: 'nodebuffer' }));
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('PDF fixture'); await writeFile(join(project, 'sample.pdf'), await pdf.save());
  const document = async args => {
    let result = data(await call('document_tool', { workspace_id: workspaceId, ...args }));
    for (let attempt = 0; attempt < 30; attempt++) {
      const body = JSON.parse(result.result);
      if (!['queued','running','finalizing'].includes(body.status)) return body;
      result = data(await call('document_tool', { workspace_id: workspaceId, action: 'result', operation_id: result.operation_id, wait_ms: 1000 }));
    }
    throw new Error('Document operation did not finish.');
  };
  for (const ext of ['xlsx','docx','pdf']) { const result = await document({ action: 'inspect', path: `sample.${ext}`, wait_ms: 1000 });
    assert(!result.error && JSON.stringify(result).toUpperCase().includes(ext.toUpperCase().replace('DOCX','DOCX'))); record(`document_tool ${ext.toUpperCase()} inspect`); }
  await document({ action: 'cell_set', path: 'sample.xlsx', sheet: 'Sheet1', cell: 'A1', value: 'Verified write', expected: 'XLSX fixture', request_key: 'xlsx-write-once' });
  const reread = new ExcelJS.Workbook(); await reread.xlsx.readFile(join(project, 'sample.xlsx')); assert.equal(reread.getWorksheet('Sheet1').getCell('A1').value, 'Verified write');
  record('Safe XLSX write with expected value and readback');
  if (selected || fixtureAgent) {
    assert(report.tools.includes('agent_mcp'));
    const capabilities = await call('agent_mcp', { action: 'list_tools' });
    report.agentTools = JSON.parse(capabilities.content[0].text).map(tool => tool.name);
    assert.deepEqual(report.agentTools, ['Read']);
    record('MCP stdio bridge lists only the permitted Read tool');

    const bridge = (token, args) => rpc(token, 'tools/call', { name: 'agent_mcp', arguments: args });
    const scopedRead = { action: 'call', workspace_id: workspaceId, tool: 'Read', arguments: { file_path: 'fixture.txt' } };
    const deniedByBridge = response => response.status === 403 || response.body.error || response.body.result?.isError;
    assert(deniedByBridge(await bridge(restricted.token, scopedRead)));
    const agentOnly = store.create({ name: 'acceptance-agent-read', allowedTools: ['agent_mcp'] });
    for (const token of [agentOnly.token, oauth.access_token]) {
      const response = await bridge(token, scopedRead);
      assert.equal(response.status, 200);
      assert(!deniedByBridge(response) && JSON.stringify(response.body.result).includes('Windows acceptance fixture'));
    }
    record('Agent Read executes with an explicit Bearer grant or OAuth and rejects a Bearer without the grant');

    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'fixture.txt'), 'Out-of-workspace acceptance fixture');
    await symlink(outside, join(project, 'linked-folder'), 'junction');
    const blocked = [
      { ...scopedRead, workspace_id: undefined },
      { ...scopedRead, workspace_id: 'unknown-workspace' },
      { ...scopedRead, arguments: { ...scopedRead.arguments, cwd: outside } },
      ...['Bash', 'Write', 'Agent'].map(tool => ({ ...scopedRead, tool })),
      ...['../outside/fixture.txt', join(outside, 'fixture.txt'), 'linked-folder/fixture.txt', 'fixture.txt:other', 'NUL'].map(file_path => ({ ...scopedRead, arguments: { file_path } })),
    ];
    for (const args of blocked) for (const token of [agentOnly.token, oauth.access_token]) {
      const response = await bridge(token, args);
      assert(deniedByBridge(response));
      assert(!JSON.stringify(response.body).includes('Out-of-workspace acceptance fixture'));
    }
    record('Agent Read rejects unsafe tools, arguments, workspaces, absolute paths, traversal, junctions and Windows device/stream paths');
    store.revoke(agentOnly.id);
    assert.equal((await bridge(agentOnly.token, scopedRead)).status, 401);
    record('Revoked agent MCP grant is rejected');
  } else {
    assert(!report.tools.includes('agent_mcp'));
    record('Agent MCP remains hidden when no supported CLI is installed');
  }
  await call('work_task', { workspace_id: workspaceId, action: 'finish', work_run_id: runId, status: 'completed', acceptance: 'passed', summary: 'Windows acceptance passed.',
    evidence: report.checks.map(check => ({ label: check.label, outcome: 'passed', reference: 'windows-acceptance.json: ' + check.label })) });
  record('Work run completion and command receipts');
  store.revoke(full.id); assert.equal((await rpc(full.token, 'tools/list')).status, 401); record('Bearer revoke takes effect');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.name ?? 'Error'; console.error(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  if (http) await new Promise(resolve => http.close(resolve));
  await running?.close(); store?.close();
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(source, 'windows-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, passed: report.checks.length, report: 'windows-acceptance.json' }));
}
