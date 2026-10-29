---
name: configurar-minimax
description: Configurar, comprobar o restaurar MiniMax M3.1 Flash en el selector de Codex mediante NVIDIA y un puente local para Windows.
---

Usa el servidor MCP minimax-jdc. Para una petición expresa de configurar o activar MiniMax, llama a configurar_minimax. El usuario introduce la clave NVIDIA en una ventana local con texto oculto; nunca le pidas que pegue la clave en el chat, ni la pases como argumento de herramienta, ni leas el archivo cifrado para mostrarlo.

Para consultar el estado usa estado_minimax. Para volver al proveedor anterior, sólo si el usuario lo pide, usa restaurar_proveedor. Desactivar o desinstalar el plugin no restaura automáticamente el proveedor: restaura primero y después desinstala.

Si MCP aún no está disponible, ejecuta node con la ruta absoluta scripts/configure.mjs dentro de la raíz instalada del plugin. No invoques codex.exe ni modifiques la instalación de Codex. No cambies ACL, políticas de ejecución, permisos ni servicios de Windows.

El complemento es local: requiere Windows y Node.js >=22. Sólo añade MiniMax de NVIDIA; mantiene las entradas GPT del catálogo original. No añade Ultra, Super VL ni proveedores de pago. No cambies el modelo de un chat por tu cuenta.

El instalador externo INSTALAR.cmd reinicia Codex automáticamente después de comprobar la conexión y activar el proveedor. La herramienta MCP configurar_minimax y la configuración directa conservan el chat abierto; sólo solicita un reinicio desde ellas si el usuario lo pide expresamente. Tras cargar la configuración, selecciona MiniMax en el selector. Comprueba el estado antes de afirmar que está activo. Una prueba del adaptador no demuestra que el selector de la app ya esté actualizado.

Para uso sin complemento, INSTALAR.cmd prepara el mercado personal, pide la clave y activa el proveedor después de una prueba real. El usuario instala la entrada MiniMax para Codex JDC desde Plugins para disponer de las herramientas de gestión y del arranque al cargar el complemento.

Compatibilidad: texto, imágenes directas y de herramientas, herramientas function/custom/MCP, historial completo, cambios de herramientas entre turnos y resumen local. Las herramientas alojadas de OpenAI, audio/vídeo y el contexto cifrado por otro proveedor no se convierten en capacidades de NVIDIA. Nunca prometas compatibilidad universal ni inventes resultados. Consulta LEEME.txt para los límites y la restauración.

MiniMax usa Code Mode y la búsqueda de herramientas del cliente con declaraciones Responses Lite, como la presentación del cliente de Terra/Luna. No reduzcas el historial, el razonamiento ni el timeout como sustituto de ese contrato. La espera de NVIDIA y la latencia de un chat nativo deben medirse por separado; un resultado del adaptador no demuestra una mejora de tokens en Codex Desktop.
