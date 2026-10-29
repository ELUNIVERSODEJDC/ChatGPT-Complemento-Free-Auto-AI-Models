import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configuredText } from '../plugins/minimax-jdc/scripts/management.mjs';
import { marketplaceWithPlugin } from '../plugins/minimax-jdc/scripts/install.mjs';
import { setProvider } from '../plugins/minimax-jdc/runtime/configurar.mjs';
import { createGateway, MINIMAX_MODEL } from '../plugins/minimax-jdc/runtime/gateway.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/minimax-jdc');

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
