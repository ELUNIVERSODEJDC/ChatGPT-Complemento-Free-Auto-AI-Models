import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configuredText, powerShellEnvironment, launchBackgroundProcess } from '../plugins/minimax-jdc/scripts/management.mjs';
import { marketplaceWithPlugin } from '../plugins/minimax-jdc/scripts/install.mjs';
import { restartAfterSetup } from '../plugins/minimax-jdc/scripts/restart.mjs';
import { setProvider } from '../plugins/minimax-jdc/runtime/configurar.mjs';
import { createGateway, MINIMAX_MODEL } from '../plugins/minimax-jdc/runtime/gateway.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/minimax-jdc');

test('Windows background server remains reachable after its launching process is terminated', { skip: process.platform !== 'win32', timeout: 25000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'minimax lifecycle ü '));
  const readyFile = path.join(directory, 'ready.json');
  const serverFile = path.join(directory, 'fixture server.mjs');
  const parentFile = path.join(directory, 'fixture parent.mjs');
  writeFileSync(serverFile, 'import http from "node:http";import {writeFileSync} from "node:fs";'
    + 'const server=http.createServer((req,res)=>res.end("lifecycle-ok"));server.listen(0,"127.0.0.1",()=>writeFileSync('
    + JSON.stringify(readyFile) + ',JSON.stringify({pid:process.pid,port:server.address().port})));');
  writeFileSync(parentFile, 'import {launchBackgroundProcess} from '
    + JSON.stringify(pathToFileURL(path.join(root, 'scripts/management.mjs')).href) + ';'
    + 'await launchBackgroundProcess(' + JSON.stringify({ executable: process.execPath, script: serverFile, cwd: directory }) + ');'
    + 'console.log("parent-ready");setInterval(()=>{},1000);');
  const parent = spawn(process.execPath, [parentFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let fixture;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Independent background launcher did not start')), 18000);
      parent.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      parent.once('exit', code => { clearTimeout(timer); reject(new Error('Launcher exited early: ' + code)); });
    });
    for (let n = 0; n < 25 && !existsSync(readyFile); n++) await new Promise(resolve => setTimeout(resolve, 100));
    fixture = JSON.parse(readFileSync(readyFile, 'utf8'));
    const owner = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Write((Get-CimInstance Win32_Process -Filter "ProcessId=' + fixture.pid + '").ParentProcessId)'],
      { windowsHide: true, timeout: 10000, encoding: 'utf8', env: powerShellEnvironment() });
    assert.notEqual(Number(owner), parent.pid);
    const parentExit = once(parent, 'exit'); parent.kill(); await parentExit;
    assert.equal(await (await fetch('http://127.0.0.1:' + fixture.port, {signal:AbortSignal.timeout(3000)})).text(), 'lifecycle-ok');
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) { const done=once(parent,'exit');parent.kill();await done; }
    if (!fixture && existsSync(readyFile)) fixture=JSON.parse(readFileSync(readyFile,'utf8'));
    if (fixture) {
      process.kill(fixture.pid);
      for (let n=0;n<30;n++) {
        let running=true;try {process.kill(fixture.pid,0);}catch {running=false;}
        if(!running)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.throws(()=>process.kill(fixture.pid,0));
    }
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('minimax lifecycle ü '));
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; '
        + '$target=[IO.Path]::GetFullPath($env:JDC_TEST_CLEANUP); '
        + '$prefix=Join-Path ([IO.Path]::GetTempPath()) "minimax lifecycle "; '
        + 'if (-not $target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {throw "Invalid fixture cleanup path"}; '
        + 'Remove-Item -LiteralPath $target -Recurse -Force'],
      { windowsHide:true,timeout:10000,env:{...powerShellEnvironment(),JDC_TEST_CLEANUP:directory} });
  }
});

test('background launcher rejects invalid executable paths before starting Windows', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(launchBackgroundProcess({executable:'bad"path',script:'fixture.mjs',cwd:root}), /Ruta de arranque/);
});

test('installer restart happens once after a successful probe and a ready provider', async () => {
  const calls = [];
  const result = await restartAfterSetup({ liveProbe: true }, {
    getStatus: async () => { calls.push('status'); return { providerSelected: true, credentialStored: true, gateway: { status: 'running' } }; },
    restart: async () => { calls.push('restart'); return { restarted: true }; }
  });
  assert.deepEqual(calls, ['status', 'restart']);
  assert.equal(result.restarted, true);
});

test('failed, cancelled or incomplete setup never restarts Codex', async () => {
  let restarted = 0;
  for (const probe of [undefined, {}, { liveProbe: false }]) {
    await assert.rejects(restartAfterSetup(probe, { restart: async () => { restarted++; } }), /sin una prueba/);
  }
  for (const state of [
    { providerSelected: false, credentialStored: true, gateway: { status: 'running' } },
    { providerSelected: true, credentialStored: false, gateway: { status: 'running' } },
    { providerSelected: true, credentialStored: true, gateway: null }
  ]) {
    await assert.rejects(restartAfterSetup({ liveProbe: true }, {
      getStatus: async () => state, restart: async () => { restarted++; }
    }), /no está listo/);
  }
  assert.equal(restarted, 0);
});

test('Windows credential encryption works despite incompatible inherited PowerShell module paths', { skip: process.platform !== 'win32' }, () => {
  const before = process.env.PSModulePath;
  try {
    process.env.PSModulePath = path.join(root, 'nonexistent-incompatible-parent-modules');
    const script = '$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString "fixture-not-a-real-key" -AsPlainText -Force; '
      + '$cipher=ConvertFrom-SecureString $s; $decoded=ConvertTo-SecureString $cipher; '
      + '$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($decoded); '
      + 'try {if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) -ne "fixture-not-a-real-key") {throw "Roundtrip failed"}; [Console]::Write("DPAPI_ROUNDTRIP_OK")} '
      + 'finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $decoded.Dispose(); $s.Dispose()}';
    const result = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, encoding: 'utf8', env: powerShellEnvironment() });
    assert.equal(result, 'DPAPI_ROUNDTRIP_OK');
    assert.equal(process.env.PSModulePath, path.join(root, 'nonexistent-incompatible-parent-modules'));
  } finally {
    if (before === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = before;
  }
});

test('portable and compatibility manifests and MCP descriptors agree', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'plugin.json')));
  const compatibility = JSON.parse(readFileSync(path.join(root, '.codex-plugin/plugin.json')));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, compatibility.name);
  assert.equal(manifest.version, compatibility.version);
  const display = manifest.extensions['com.openai'].interface;
  assert.ok(display.shortDescription.length <= 30);
  assert.equal(display.category, 'Developer Tools');
  assert.equal(display.displayName, compatibility.interface.displayName);
  const portable = JSON.parse(readFileSync(path.join(root, 'mcp.json')));
  const legacy = JSON.parse(readFileSync(path.join(root, '.mcp.json')));
  const { type, ...server } = portable.mcpServers['minimax-jdc'];
  assert.deepEqual(server, legacy.mcpServers['minimax-jdc']);
  assert.match(readFileSync(path.join(root, 'skills/configurar-minimax/SKILL.md'), 'utf8'), /^---\r?\nname: configurar-minimax\r?\n/);
});

test('provider install is idempotent and preserves GPT defaults and unrelated secrets', () => {
  const before = 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "high"\n\n[unrelated]\nvalue = "test-only"\n';
  const after = configuredText(before);
  assert.equal(configuredText(after), after);
  assert.ok(after.includes(before));
  assert.equal((after.match(/\[model_providers\.minimax_jdc\]/g) || []).length, 1);
  assert.ok(setProvider(after, null).startsWith(before));
  assert.throws(() => configuredText('model_catalog_json = "custom.json"\n'), /catálogo local/);
  assert.throws(() => configuredText('[model_providers.minimax_jdc]\nbase_url = "other"\n'), /distinta/);
});

test('personal marketplace preserves other entries and creates no duplicate MiniMax entry', () => {
  const before = { name: 'existing-personal', plugins: [{ name: 'other', source: './other', policy: { installation: 'AVAILABLE' } }] };
  const copy = structuredClone(before);
  const after = marketplaceWithPlugin(before);
  assert.deepEqual(before, copy);
  assert.equal(after.name, before.name);
  assert.deepEqual(after.plugins[0], before.plugins[0]);
  assert.equal(after.plugins[1].source.path, './.codex/plugins/minimax-jdc');
  assert.deepEqual(marketplaceWithPlugin(after), after);
});

test('package contains no local credentials, account config, personal paths or dependencies', () => {
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      assert.ok(!/^(node_modules|\.git|auth\.json|clave-nvidia\.txt|config\.toml|nvidia-key\.dpapi)$/.test(entry.name));
      if (entry.isDirectory()) scan(filename);
      else {
        const text = readFileSync(filename, 'utf8');
        assert.ok(!/nvapi-[A-Za-z0-9_-]{24,}/.test(text), filename);
        assert.ok(!/C:[\\/]Users[\\/]Jorge/.test(text), filename);
      }
    }
  };
  scan(root);
});

test('packaged HTTP gateway handles compaction replay with its own injected key', async () => {
  let sent;
  const gateway = createGateway({ keyProvider: async () => 'test-nvidia-only', allowedModels: [MINIMAX_MODEL], port: 8769,
    fetcher: async (url, options) => {
      if (url.includes('/models?')) return Response.json({ models: [] });
      assert.equal(options.headers.Authorization, 'Bearer test-nvidia-only');
      sent = JSON.parse(options.body);
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Summary OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + gateway.address().port + '/v1/responses', {
      method: 'POST', headers: { Authorization: 'Bearer openai-test-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MINIMAX_MODEL, tools: [], stream: false, input: [
        { role: 'user', content: 'Summarize.' },
        { type: 'function_call', name: 'exec_command', call_id: 'previous', arguments: '{}' },
        { type: 'function_call_output', call_id: 'previous', output: 'History evidence' }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'completed');
    assert.equal(sent.messages[2].content, 'History evidence');
    assert.equal(sent.tools, undefined);
  } finally { gateway.closeAllConnections(); gateway.close(); await once(gateway, 'close'); }
});

test('MCP initializes, discovers tools and reports harmless status without configuration changes', async () => {
  const child = spawn(process.execPath, [path.join(root, 'scripts/server.mjs')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOCALAPPDATA: path.resolve(root, '../../work/nemotron-codex/plugin-test-data'),
      CODEX_HOME: path.resolve(root, '../../work/nemotron-codex/plugin-test-codex') } });
  let pending = '';
  const requests = new Map();
  child.stdout.on('data', bytes => {
    pending += bytes;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const result = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      requests.get(result.id)?.(result);
    }
  });
  const call = (id, method, params) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MCP test timeout')), 6000);
    requests.set(id, value => { clearTimeout(timeout); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const init = await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'protocol-test', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    const list = await call(2, 'tools/list', {});
    assert.deepEqual(list.result.tools.map(t => t.name), ['estado_minimax', 'configurar_minimax', 'restaurar_proveedor']);
    const result = await call(3, 'tools/call', { name: 'estado_minimax', arguments: {} });
    const state = JSON.parse(result.result.content[0].text);
    assert.equal(state.credentialStored, false);
    assert.equal(state.providerSelected, false);
    const rejected = await call(4, 'tools/call', { name: 'configurar_minimax', arguments: { apiKey: 'test-only' } });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /no acepta argumentos/);
  } finally { child.kill(); await once(child, 'exit'); assert.ok(child.exitCode !== null || child.signalCode); }
});
