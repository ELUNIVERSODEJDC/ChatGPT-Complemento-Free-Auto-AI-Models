import { configure, restore, status } from './management.mjs';
import { restartAfterSetup } from './restart.mjs';
try {
  const action = process.argv[2] || 'configurar';
  if (!['configurar', 'restaurar', 'estado'].includes(action)) throw new Error('Acción desconocida.');
  const restartRequested = process.argv.slice(3).includes('--restart-codex');
  if (restartRequested && action !== 'configurar') throw new Error('El reinicio sólo se admite después de configurar.');
  const result = await (action === 'restaurar' ? restore() : action === 'estado' ? status() : configure({ onProgress: message => console.error(message) }));
  if (restartRequested) result.nextStep = 'Conexión comprobada y configuración guardada. Se reiniciará Codex para cargar Kilo Auto Free.';
  console.log(JSON.stringify(result, null, 2));
  if (restartRequested) console.log(JSON.stringify(await restartAfterSetup(result, { log: message => console.error(message) }), null, 2));
} catch (error) {
  console.error(String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]'));
  process.exitCode = 1;
}
