import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generate, MINIMAX_MODEL, BRIDGE_REVISION } from '../runtime/gateway.mjs';
import { topLevel, setProvider } from '../runtime/configurar.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const PROVIDER = 'minimax_jdc';
export const PORT = 8769;
export const BASE = 'http://127.0.0.1:' + PORT;
export const DATA = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'ELUNIVERSODEJDC', 'MiniMaxCodex');
export const CONFIG = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
const STATE = path.join(DATA, 'provider-state.json');
const sha = data => createHash('sha256').update(data).digest('hex');
const selected = text => /^\s*model_provider\s*=\s*["']([^"']+)["']/m.exec(topLevel(text))?.[1] || null;
const table = '\n[model_providers.' + PROVIDER + ']\nname = "MiniMax NVIDIA JDC + OpenAI"\n'
  + 'base_url = "' + BASE + '/v1"\nmodel_catalog_url = "' + BASE + '/v1/models"\n'
  + 'wire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n'
  + 'request_max_retries = 1\nstream_max_retries = 1\nstream_idle_timeout_ms = 300000\n';

export function configuredText(original) {
  if (/^\s*model_catalog_json\s*=/m.test(topLevel(original))) throw new Error('Hay un catálogo local existente. Debe reconciliarse antes de activar MiniMax.');
  const match = /^\[model_providers\.minimax_jdc\][\s\S]*?(?=^\[|(?![\s\S]))/m.exec(original);
  if (match && match[0].trim() !== table.trim()) throw new Error('La definición existente minimax_jdc es distinta; no se sobrescribe.');
  return setProvider(match ? original : original.trimEnd() + '\n' + table, PROVIDER);
}

function atomic(filename, content) {
  const temp = filename + '.minimax-jdc-pending';
  writeFileSync(temp, content, { flag: 'wx' });
  renameSync(temp, filename);
}

export async function storedKey() {
  if (process.platform !== 'win32') throw new Error('Este complemento requiere Windows.');
  if (!existsSync(path.join(DATA, 'nvidia-key.dpapi'))) return undefined;
  const script = '$ErrorActionPreference="Stop"; $s=ConvertTo-SecureString ([IO.File]::ReadAllText((Join-Path $env:JDC_MINIMAX_DATA "nvidia-key.dpapi"))); '
    + '$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $s.Dispose()}';
  const { stdout } = await run(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000, maxBuffer: 8192, env: { ...process.env, JDC_MINIMAX_DATA: DATA } });
  return stdout.trim() || undefined;
}

export async function health() {
  let response;
  try { response = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2500) }); }
  catch { return null; }
  if (!response.ok) throw new Error('El puerto local de MiniMax está ocupado por otro servicio.');
  const result = await response.json();
  if (result.service !== 'nemotron-codex' || result.models?.length !== 1 || result.models[0] !== MINIMAX_MODEL)
    throw new Error('El puerto 8769 está ocupado por otro servicio. No se sustituye.');
  if (result.bridgeRevision !== BRIDGE_REVISION) throw new Error('Hay una versión anterior del puente activa. Cierra sus peticiones antes de actualizarla.');
  return result;
}

export async function launchBridge() {
  const running = await health();
  if (running) return running;
  mkdirSync(DATA, { recursive: true });
  const out = openSync(path.join(DATA, 'gateway.log'), 'a');
  const err = openSync(path.join(DATA, 'gateway-error.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'server.mjs'), '--gateway-only'],
      { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', out, err] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    writeFileSync(path.join(DATA, 'gateway-process.json'), JSON.stringify({ pid: child.pid, executable: process.execPath,
      script: path.join(ROOT, 'scripts', 'server.mjs'), cwd: ROOT, startedAt: new Date().toISOString() }, null, 2));
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  for (let n = 0; n < 20; n++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const ready = await health();
    if (ready) return ready;
  }
  throw new Error('El puente no arrancó; consulta gateway-error.log en ' + DATA);
}

export async function status() {
  return { plugin: 'minimax-jdc', model: MINIMAX_MODEL, credentialStored: existsSync(path.join(DATA, 'nvidia-key.dpapi')),
    providerSelected: existsSync(CONFIG) && selected(readFileSync(CONFIG, 'utf8')) === PROVIDER,
    gateway: await health(), dataDirectory: DATA };
}

export async function configure() {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Se requiere Windows con Node.js 22 o posterior.');
  mkdirSync(DATA, { recursive: true });
  const credentialScript = readFileSync(path.join(ROOT, 'scripts', 'credential.ps1'), 'utf8');
  try {
    await run(PS, ['-NoLogo', '-NoProfile', '-STA', '-Command', credentialScript],
      { windowsHide: true, timeout: 600000, env: { ...process.env, JDC_MINIMAX_DATA: DATA } });
  } catch { throw new Error('La ventana de clave se canceló, agotó su espera o no pudo abrirse. No se ha cambiado el proveedor.'); }
  const key = await storedKey();
  if (!key) throw new Error('No se pudo recuperar la clave guardada.');
  const result = await generate({ model: MINIMAX_MODEL, input: 'Reply with exactly OK.', max_output_tokens: 2048,
    reasoning: { effort: 'low' } }, () => {}, { key, signal: AbortSignal.timeout(60000) });
  if (result.status !== 'completed' || !result.output.some(i => i.type === 'message' && i.content.some(p => p.text?.trim())))
    throw new Error('NVIDIA no completó la prueba. El proveedor no se ha cambiado.');
  await launchBridge();
  const original = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
  const next = configuredText(original);
  const previous = selected(original);
  if (previous !== PROVIDER) {
    // Save the durable recovery record before selecting the provider. Preserve
    // unrelated concurrent configuration and never restore an old whole file.
    mkdirSync(path.dirname(CONFIG), { recursive: true });
    const backup = path.join(DATA, 'config-before-' + Date.now() + '.toml');
    if (existsSync(CONFIG)) copyFileSync(CONFIG, backup);
    const state = { previousProvider: previous, backup, config: CONFIG, beforeSHA256: sha(original),
      afterSHA256: sha(next), at: new Date().toISOString(), model: MINIMAX_MODEL, liveProbe: true };
    atomic(STATE, JSON.stringify(state, null, 2));
    const fresh = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
    if (fresh !== original) throw new Error('config.toml cambió durante la preparación. No se ha sobrescrito.');
    atomic(CONFIG, next);
  }
  return { ...await status(), liveProbe: true,
    nextStep: 'MiniMax está configurado. Carga la configuración nueva de Codex y selecciona MiniMax-M3.1-Flash. No se ha reiniciado Codex.' };
}

export function restore() {
  if (!existsSync(STATE) || !existsSync(CONFIG)) return { restored: false, reason: 'No hay activación anterior registrada.' };
  const current = readFileSync(CONFIG, 'utf8');
  if (selected(current) !== PROVIDER) return { restored: false, reason: 'Ya está seleccionado otro proveedor; se conserva.' };
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  if (state.config !== CONFIG || state.previousProvider === PROVIDER) throw new Error('El registro de restauración no es válido.');
  const next = setProvider(current, state.previousProvider);
  if (readFileSync(CONFIG, 'utf8') !== current) throw new Error('La configuración cambió; no se sobrescribe.');
  atomic(CONFIG, next);
  return { restored: true, previousProvider: state.previousProvider,
    nextStep: 'Carga la configuración nueva antes de desinstalar el plugin. No se ha reiniciado Codex.' };
}
