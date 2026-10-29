import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
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
// Node may be launched from PowerShell 7. Its PSModulePath is incompatible with
// Windows PowerShell 5.1 security modules; isolate only our child process.
export function powerShellEnvironment(dataDirectory = DATA) {
  return { ...process.env, JDC_MINIMAX_DATA: dataDirectory,
    PSModulePath: path.join(path.dirname(PS), 'Modules') };
}
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
    { windowsHide: true, timeout: 10000, maxBuffer: 8192, env: powerShellEnvironment() });
  return stdout.trim() || undefined;
}

export async function health({ allowStale = false } = {}) {
  let response;
  try { response = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2500) }); }
  catch { return null; }
  if (!response.ok) throw new Error('El puerto local de MiniMax está ocupado por otro servicio.');
  const result = await response.json();
  if (result.service !== 'nemotron-codex' || result.models?.length !== 1 || result.models[0] !== MINIMAX_MODEL)
    throw new Error('El puerto 8769 está ocupado por otro servicio. No se sustituye.');
  if (result.bridgeRevision !== BRIDGE_REVISION) {
    if (!allowStale) throw new Error('Hay una versión anterior del puente activa. Cierra sus peticiones antes de actualizarla.');
    return { ...result, needsRestart: true };
  }
  return result;
}

// Windows owns the background process, independently of the short-lived
// installer/MCP/tool process. Node detached/unref alone does not provide that
// lifetime when the desktop closes its process tree. No service or task is added.
export async function launchBackgroundProcess({ executable, script, cwd, environment = process.env }) {
  if (process.platform !== 'win32') throw new Error('El arranque independiente requiere Windows.');
  const quote = value => {
    if (/["\r\n]/.test(value)) throw new Error('Ruta de arranque no válida.');
    return '"' + value.replace(/(\\+)$/, '$1$1') + '"';
  };
  const command = quote(executable) + ' ' + quote(script) + ' --gateway-only';
  const childEnvironment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PATH',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ComSpec', 'CODEX_HOME']) {
    const actual = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
    if (actual && environment[actual] !== undefined) childEnvironment[actual] = environment[actual];
  }
  childEnvironment.JDC_GATEWAY_LAUNCH_METHOD = 'windows-cim';
  const launcher = '$ErrorActionPreference="Stop"; '
    + '$envItems=[string[]]@((ConvertFrom-Json $env:JDC_BRIDGE_ENV).PSObject.Properties | ForEach-Object { $_.Name + "=" + [string]$_.Value }); '
    + '$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0; CreateFlags=[uint32]1032; EnvironmentVariables=$envItems}; '
    + '$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:JDC_BRIDGE_COMMAND;CurrentDirectory=$env:JDC_BRIDGE_ROOT;ProcessStartupInformation=$startup}; '
    + 'if ($result.ReturnValue -ne 0) {throw ("Windows no pudo iniciar el puente: " + $result.ReturnValue)}; '
    + '[Console]::Write(([pscustomobject]@{pid=[int]$result.ProcessId;method="windows-cim"}|ConvertTo-Json -Compress))';
  const { stdout } = await run(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', launcher],
    { windowsHide: true, timeout: 15000, maxBuffer: 8192, env: { ...powerShellEnvironment(),
      JDC_BRIDGE_COMMAND: command, JDC_BRIDGE_ROOT: cwd, JDC_BRIDGE_ENV: JSON.stringify(childEnvironment) } });
  const result = JSON.parse(stdout);
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error('Windows no devolvió un PID válido del puente.');
  return result;
}

let launching;
export async function launchBridge() {
  if (launching) return launching;
  launching = startBridge();
  try { return await launching; } finally { launching = undefined; }
}

async function startBridge() {
  const running = await health();
  if (running) return running;
  mkdirSync(DATA, { recursive: true });
  const child = await launchBackgroundProcess({ executable: process.execPath,
    script: path.join(ROOT, 'scripts', 'server.mjs'), cwd: ROOT });
  for (let n = 0; n < 20; n++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const ready = await health();
    if (ready) {
      if (ready.pid !== child.pid) throw new Error('El puerto fue ocupado por otro proceso durante el arranque.');
      return ready;
    }
  }
  throw new Error('El puente no arrancó; consulta gateway-error.log en ' + DATA);
}

export async function status() {
  return { plugin: 'minimax-jdc', model: MINIMAX_MODEL, credentialStored: existsSync(path.join(DATA, 'nvidia-key.dpapi')),
    providerSelected: existsSync(CONFIG) && selected(readFileSync(CONFIG, 'utf8')) === PROVIDER,
    gateway: await health({ allowStale: true }), dataDirectory: DATA };
}

export async function configure({ onProgress = () => {} } = {}) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Se requiere Windows con Node.js 22 o posterior.');
  mkdirSync(DATA, { recursive: true });
  const credentialScript = readFileSync(path.join(ROOT, 'scripts', 'credential.ps1'), 'utf8');
  onProgress('Abriendo la ventana «MiniMax para Codex - Clave NVIDIA». Introduce la clave en esa ventana.');
  try {
    await run(PS, ['-NoLogo', '-NoProfile', '-STA', '-Command', credentialScript],
      { windowsHide: true, timeout: 600000, env: powerShellEnvironment() });
  } catch (error) {
    if (error.code === 2) throw new Error('Se canceló la ventana de clave. No se ha cambiado el proveedor.');
    if (error.killed) throw new Error('Se agotó la espera de la ventana de clave (10 minutos). No se ha cambiado el proveedor.');
    const detail = String(error.stderr || error.code || 'error desconocido').replace(/nvapi-[\w-]+/g, '[REDACTED]').trim().slice(0, 1200);
    throw new Error('No se pudo abrir o completar la ventana de clave: ' + detail + '. No se ha cambiado el proveedor.');
  }
  onProgress('Clave guardada cifrada. Comprobando la conexión con NVIDIA...');
  const key = await storedKey();
  if (!key) throw new Error('No se pudo recuperar la clave guardada.');
  const result = await generate({ model: MINIMAX_MODEL, input: 'Reply with exactly OK.', max_output_tokens: 2048,
    reasoning: { effort: 'low' } }, () => {}, { key, signal: AbortSignal.timeout(60000) });
  if (result.status !== 'completed' || !result.output.some(i => i.type === 'message' && i.content.some(p => p.text?.trim())))
    throw new Error('NVIDIA no completó la prueba. El proveedor no se ha cambiado.');
  await launchBridge();
  onProgress('Conexión comprobada. Activando el proveedor del complemento...');
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
