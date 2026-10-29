import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { powerShellEnvironment, status } from './management.mjs';

const run = promisify(execFile);
// Match the Store desktop package, never the separate codex.exe CLI/backend.
export const restartScript = String.raw`
$ErrorActionPreference = 'Stop'
$package = @(Get-AppxPackage -Name OpenAI.Codex)
if ($package.Count -ne 1) { throw 'No se identifica una única instalación de Codex Desktop.' }
$appExe = [IO.Path]::GetFullPath((Join-Path $package[0].InstallLocation 'app\ChatGPT.exe'))
if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) { throw 'No se encuentra la aplicación de escritorio de Codex.' }
$apps = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appExe })
if ($env:JDC_MINIMAX_RESTART_PLAN -eq '1') {
  @{ action='restart-desktop'; executable=$appExe; processIds=@($apps | ForEach-Object {$_.Id}); dryRun=$true } | ConvertTo-Json -Compress
  exit 0
}
foreach ($app in $apps) { if ($app.MainWindowHandle -ne [IntPtr]::Zero) { $app.CloseMainWindow() | Out-Null } }
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  $remaining = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appExe })
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
# Desktop apps can remain resident after their last window closes. Complete
# this explicit installer restart only for the verified desktop executable.
foreach ($app in $remaining) {
  $current = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if ($current -and $current.Path -eq $appExe) { Stop-Process -InputObject $current -Force -ErrorAction Stop }
}
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $remaining = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appExe })
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
if ($remaining.Count -ne 0) { throw 'Codex Desktop no se cerró; no se abre otra instancia.' }
Start-Process -FilePath $appExe -WindowStyle Normal
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $opened = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $appExe })
  if ($opened.Count -gt 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($opened.Count -eq 0) { throw 'Se cerró Codex, pero no se ha confirmado su reapertura. Ábrelo desde Inicio.' }
@{ restarted=$true; processIds=@($opened | ForEach-Object {$_.Id}) } | ConvertTo-Json -Compress
`;

export async function restartCodex({ dryRun = false } = {}) {
  if (process.platform !== 'win32') throw new Error('El reinicio requiere Windows.');
  let stdout;
  try {
    ({ stdout } = await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', restartScript],
      { windowsHide: true, timeout: 45000, env: { ...powerShellEnvironment(), JDC_MINIMAX_RESTART_PLAN: dryRun ? '1' : '0' } }));
  } catch (error) {
    throw new Error('No se completó el reinicio de Codex: ' + String(error.stderr || error.code || 'error desconocido').trim().slice(0, 1000));
  }
  return JSON.parse(stdout);
}

export async function restartAfterSetup(result, { getStatus = status, restart = restartCodex, log = () => {} } = {}) {
  if (result?.liveProbe !== true) throw new Error('No se reinicia Codex sin una prueba de conexión completada.');
  const current = await getStatus();
  if (!current.providerSelected || !current.credentialStored || current.gateway?.status !== 'running')
    throw new Error('MiniMax no está listo; no se reinicia Codex.');
  log('Configuración completada. Reiniciando Codex para cargar MiniMax...');
  return restart();
}
