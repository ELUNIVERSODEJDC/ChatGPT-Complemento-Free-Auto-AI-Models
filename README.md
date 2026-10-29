# Auto Free para Codex JDC

Complemento para Windows que añade **Kilo Auto Free** al selector de Codex y conserva los modelos GPT. Usa la ruta real `kilo-auto/free`: Kilo selecciona los modelos gratuitos disponibles. No instala Kilo Code ni replica su algoritmo de selección.

La versión 0.2.0 sustituye las tres entradas de NVIDIA. No necesita clave API. Mantiene la identidad `minimax-jdc` para actualizar la instalación anterior.

## Instalación

1. Instala Node.js 22 o posterior.
2. Descarga [minimax-jdc-0.2.0.zip](dist/minimax-jdc-0.2.0.zip), extrae la carpeta y ejecuta `INSTALAR.cmd`.
3. El instalador registra el complemento, verifica una respuesta real y activa el proveedor. Después reinicia Codex.
4. Activa **Auto Free para Codex JDC** en Plugins para arrancar el puente automáticamente y selecciona **Kilo Auto Free** en el selector.

La instalación en curso desde un chat puede usar `node scripts/install.mjs --no-restart` para conservarlo abierto y recargar Codex al terminar. El comando normal de instalación conserva el reinicio automático pedido por el usuario.

## Cómo funciona

`Codex (Responses HTTP) → puente local → Kilo (Chat Completions) → kilo-auto/free`

El adaptador conserva Code Mode, Responses Lite, herramientas custom/function con namespaces, descubrimiento del cliente, historial y resultados. Los GPT se reenvían a OpenAI con su autenticación original. La ruta gratuita no recibe la sesión OpenAI ni la clave NVIDIA histórica. No se activa ninguna ruta de pago.

El catálogo de Kilo consultado el 29 de octubre de 2026 anuncia 256000 tokens de contexto, hasta 32768 de salida, texto y herramientas. Auto Free no anuncia imágenes ni un esfuerzo de razonamiento seleccionable; se muestran esas capacidades reales. Kilo puede cambiar los modelos disponibles.

## Actualización y restauración

La identidad `minimax-jdc`, la carpeta de datos heredada y el puerto local se mantienen. La clave NVIDIA cifrada existente se conserva sin leerla ni enviarla. El instalador ya no incluye su ventana de clave. La configuración sólo migra la tabla exacta conocida del complemento y conserva el resto de `config.toml` y el proveedor anterior registrado.

Los chats con un modelo NVIDIA deben cambiarse a Kilo Auto Free o sustituirse por un chat nuevo. Las entradas anteriores ya no se muestran ni aceptan peticiones de inferencia.

MCP ofrece `estado_auto_free`, `configurar_auto_free` y `restaurar_proveedor`. Los nombres antiguos de gestión son alias para continuidad. Ejecuta `RESTAURAR PROVEEDOR.cmd` antes de desinstalar si deseas volver al proveedor anterior.

## Acceso gratuito y datos

Kilo documenta acceso anónimo limitado a 200 peticiones por hora e IP. La disponibilidad y velocidad dependen del servicio; no se garantiza una latencia. Los proveedores gratuitos pueden registrar consultas y usarlas para mejorar sus servicios. No emplees esta ruta con datos personales o confidenciales.

## Validación

`VALIDACION.json` contiene la evidencia de esta versión y distingue pruebas del adaptador, consultas reales y funcionamiento del selector nativo. Una respuesta HTTP o un catálogo correcto no prueban por sí solos una conversación completa en Codex. La suite usa `node --test tests/test_gateway.mjs tests/test_plugin.mjs`.

## Fuentes

- [Autenticación y acceso anónimo de Kilo](https://kilo.ai/docs/gateway/authentication).
- [Auto Free y selección de modelos](https://kilo.ai/docs/code-with-ai/agents/auto-model).
- [Catálogo de Kilo](https://kilo.ai/docs/gateway/models-and-providers).
- [Contrato de gateway de Codex](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).

Integración independiente de ELUNIVERSODEJDC. No es un producto oficial de Kilo ni de OpenAI. Las versiones 0.1.x son históricas y usaban NVIDIA.
