import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, MODEL_SETTINGS, MINIMAX_MODEL } from '../runtime/gateway.mjs';
import { configure, restore, status, launchBridge, storedKey, PORT, DATA } from './management.mjs';
for (const [model, settings] of MODEL_SETTINGS) settings.listed = model === MINIMAX_MODEL;

const tools = [
  { name: 'estado_minimax', description: 'Estado del puente y de la configuración. Nunca devuelve la clave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'configurar_minimax', description: 'Abre una ventana local privada para introducir la clave NVIDIA, comprueba MiniMax y activa su proveedor conservando GPT. Sólo por petición expresa del usuario.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'restaurar_proveedor', description: 'Vuelve al proveedor anterior conservando el resto de config.toml. Sólo cuando lo pide el usuario.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
if (process.argv.includes('--gateway-only')) {
  mkdirSync(DATA, { recursive: true });
  const logError = error => appendFileSync(path.join(DATA, 'gateway-error.log'),
    new Date().toISOString() + ' MiniMax gateway: ' + String(error.code || error.name || 'runtime_error') + '\n');
  const server = createGateway({ keyProvider: storedKey, port: PORT, allowedModels: [MINIMAX_MODEL] });
  server.requestTimeout = 360000;
  server.headersTimeout = 30000;
  server.on('error', error => { logError(error); process.exitCode = 1; });
  process.on('uncaughtException', error => { logError(error); process.exit(1); });
  process.on('unhandledRejection', error => { logError(error || {}); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    const script = fileURLToPath(import.meta.url);
    writeFileSync(path.join(DATA, 'gateway-process.json'), JSON.stringify({ pid: process.pid,
      executable: process.execPath, script, cwd: path.resolve(path.dirname(script), '..'),
      startedAt: new Date().toISOString(), launchMethod: process.env.JDC_GATEWAY_LAUNCH_METHOD || 'direct' }, null, 2));
    appendFileSync(path.join(DATA, 'gateway.log'), new Date().toISOString() + ' minimax-jdc gateway pid=' + process.pid + '\n');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
} else {
  // Startup only restores the runtime, never requests a secret or edits config.
  storedKey().then(key => key ? launchBridge() : undefined)
    .catch(error => console.error('MiniMax: ' + String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]')));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  let mutation = false;
  lines.on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    if (request.id === undefined) return;
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
      reply({ protocolVersion: versions.includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'minimax-jdc', version: '0.1.0' } });
    } else if (request.method === 'ping') reply({});
    else if (request.method === 'tools/list') reply({ tools });
    else if (request.method === 'tools/call') {
      const name = request.params?.name;
      const mutates = name === 'configurar_minimax' || name === 'restaurar_proveedor';
      if (mutates && mutation) { reply({ isError: true, content: [{ type: 'text', text: 'Hay una configuración en curso. Espera a que termine.' }] }); return; }
      try {
        if (!tools.some(t => t.name === name)) throw new Error('Herramienta desconocida.');
        if (Object.keys(request.params?.arguments || {}).length) throw new Error('Esta herramienta no acepta argumentos ni claves.');
        if (mutates) mutation = true;
        const value = name === 'estado_minimax' ? await status() : name === 'configurar_minimax' ? await configure() : restore();
        reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      } catch (error) {
        reply({ isError: true, content: [{ type: 'text', text: String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]') }] });
      } finally { if (mutates) mutation = false; }
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  });
}
