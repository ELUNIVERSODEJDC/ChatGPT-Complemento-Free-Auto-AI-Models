import { configure, restore, status } from './management.mjs';
try {
  const action = process.argv[2] || 'configurar';
  if (!['configurar', 'restaurar', 'estado'].includes(action)) throw new Error('Acción desconocida.');
  console.log(JSON.stringify(await (action === 'restaurar' ? restore() : action === 'estado' ? status() : configure()), null, 2));
} catch (error) {
  console.error(String(error.message).replace(/nvapi-[\w-]+/g, '[REDACTED]'));
  process.exitCode = 1;
}
