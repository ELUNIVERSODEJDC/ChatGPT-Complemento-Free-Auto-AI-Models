import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function marketplaceWithPlugin(original) {
  const result = structuredClone(original || { name: 'jdc-local', interface: { displayName: 'Complementos JDC' }, plugins: [] });
  if (typeof result.name !== 'string' || !Array.isArray(result.plugins)) throw new Error('El mercado personal existente tiene otro formato. No se modifica.');
  const entry = { name: 'minimax-jdc', source: { source: 'local', path: './.codex/plugins/minimax-jdc' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' };
  const index = result.plugins.findIndex(p => p.name === entry.name);
  if (index >= 0) result.plugins[index] = { ...result.plugins[index], ...entry };
  else result.plugins.push(entry);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Se requiere Windows y Node.js 22 o posterior.');
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const destination = path.join(homedir(), '.codex', 'plugins', 'minimax-jdc');
    const marketFile = path.join(homedir(), '.agents', 'plugins', 'marketplace.json');
    const before = existsSync(marketFile) ? readFileSync(marketFile, 'utf8') : null;
    const market = marketplaceWithPlugin(before ? JSON.parse(before) : undefined);
    if (existsSync(destination)) {
      const installed = JSON.parse(readFileSync(path.join(destination, 'plugin.json'), 'utf8'));
      if (installed.name !== 'minimax-jdc') throw new Error('La carpeta de destino no pertenece al complemento. No se sobrescribe.');
    }
    const obsolete = path.join(destination, 'scripts', 'credential.ps1');
    if (existsSync(obsolete) && createHash('sha256').update(readFileSync(obsolete)).digest('hex')
      !== '8bb41b648cbd45a83017d7458022a6488cb01231db9939f4d58c9b83a8120d1a')
      throw new Error('La antigua ventana de clave tiene cambios ajenos; revísala antes de actualizar.');
    if (source !== destination) { mkdirSync(destination, { recursive: true }); cpSync(source, destination, { recursive: true }); }
    if (existsSync(obsolete)) unlinkSync(obsolete);
    mkdirSync(path.dirname(marketFile), { recursive: true });
    const current = existsSync(marketFile) ? readFileSync(marketFile, 'utf8') : null;
    if (current !== before) throw new Error('El mercado cambió durante la instalación. No se sobrescribe.');
    const pending = marketFile + '.minimax-jdc-pending';
    writeFileSync(pending, JSON.stringify(market, null, 2), { flag: 'wx' });
    renameSync(pending, marketFile);
    console.log('Complemento registrado como Auto Free para Codex JDC. Comprobando Kilo; no se necesita clave API.');
    const child = spawn(process.execPath, [path.join(destination, 'scripts', 'configure.mjs'), 'configurar',
      ...(process.argv.includes('--no-restart') ? [] : ['--restart-codex'])], { stdio: 'inherit', windowsHide: true });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    child.on('error', () => { console.error('No se pudo abrir el configurador.'); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
