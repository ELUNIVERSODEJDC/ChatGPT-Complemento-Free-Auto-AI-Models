# ChatGPT Complemento Free Auto AI Models

Primera versión: **MiniMax para Codex JDC**, un complemento local para Windows
que añade `minimaxai/minimax-m3.1-flash` de NVIDIA al selector de modelos de Codex
mediante un puente local. Conserva las entradas GPT del catálogo original.

El modo **Auto** todavía no está implementado. Esta versión utiliza MiniMax
de forma fija; el nombre del repositorio reserva el proyecto para ampliaciones.

## Instalar o recuperar después de reinstalar Codex

1. Descarga [el ZIP de instalación](dist/minimax-jdc-0.1.3.zip) y extráelo.
2. Instala Node.js 22 o posterior si tu equipo no lo tiene.
3. Ejecuta `INSTALAR.cmd` e introduce tu **clave de NVIDIA** en la ventana privada.
4. El instalador prueba la API y sólo activa el proveedor si MiniMax responde.
5. El instalador reinicia Codex automáticamente para cargar la configuración;
   selecciona **MiniMax-M3.1-Flash**.
6. En **Plugins**, instala **MiniMax para Codex JDC** desde tu mercado personal
   para disponer de sus herramientas de gestión y de su arranque al cargarlo.

También puedes agregar este repositorio como mercado de plugins, instalar la
entrada y pedir **«Configura MiniMax»** para abrir el configurador.
La configuración no se ejecuta automáticamente al descargar el plugin.

El instalador mantiene tu modelo GPT predeterminado y los ajustes ajenos al
proveedor. No instala servicios y no crea tareas de Windows.
La lista del selector debe recargarse después de cambiar de proveedor.

La versión **0.1.1** abre el formulario de clave sobre las otras ventanas,
enfoca su campo y muestra el progreso en consola. Si lo cancelas, transcurren
10 minutos o PowerShell falla, comunica la causa y conserva el proveedor anterior.
La **0.1.2** aísla las rutas de módulos de los procesos de Windows PowerShell
que cifran y descifran la clave. Corrige la carga de `Microsoft.PowerShell.Security`
cuando Node hereda las rutas de PowerShell 7, sin cambiar el entorno global.
La **0.1.3** reinicia Codex Desktop de Windows al terminar `INSTALAR.cmd`,
únicamente tras una prueba NVIDIA correcta y con el proveedor listo. Identifica
el ejecutable del paquete `OpenAI.Codex`, cierra sus procesos de escritorio y
comprueba su reapertura. La configuración MCP mantiene el chat abierto.

## Clave y almacenamiento

La clave se introduce en una ventana con texto oculto y se guarda con DPAPI,
vinculada a tu usuario de Windows y equipo. No se escribe en el chat ni en
`config.toml`. Si reinstalas Windows o cambias de equipo, introdúcela otra vez.

El código queda en `%USERPROFILE%\.codex\plugins\minimax-jdc`; la clave cifrada,
los registros y la recuperación local están en
`%LOCALAPPDATA%\ELUNIVERSODEJDC\MiniMaxCodex`.
Los datos de usuario y claves **no forman parte de este repositorio**.

El puente escucha sólo en `127.0.0.1:8769`. MiniMax utiliza NVIDIA; las
peticiones GPT mantienen la ruta OpenAI y su credencial no se envía a NVIDIA.
Usa el endpoint NVIDIA marcado como Free Endpoint, sujeto a su disponibilidad,
condiciones y límites. No cambia a una alternativa de pago automáticamente.

## Qué está comprobado

- Traducción Responses a Chat Completions con eventos SSE y finalización.
- Herramientas function/custom/MCP, llamadas paralelas e historial completo.
- Continuación con herramientas usadas anteriormente y retiradas del conjunto actual.
- Resumen sin herramientas, usado por la compactación local.
- Imágenes directas y devueltas por herramientas, conservando su texto asociado.
- JSON por esquema y conservación de catálogo/configuración de modelos GPT.
- Descubrimiento y consulta de las tres herramientas MCP del complemento.

La validación local automatizada y las comprobaciones reales de NVIDIA se
resumen en [VALIDACION.json](VALIDACION.json). Una prueba de protocolo no
demuestra por sí sola que el selector de una instalación concreta se haya
actualizado. La instalación del complemento en la interfaz real está pendiente
de esa comprobación y no se declara completada por publicar este repositorio.

No se promete compatibilidad universal: las herramientas alojadas de OpenAI,
su compactación remota y contexto cifrado, audio/vídeo y `previous_response_id`
de NVIDIA no están implementados en esta versión.

## Restaurar o desinstalar

Pide **«Restaura el proveedor anterior»** con el complemento activo, o ejecuta
`RESTAURAR PROVEEDOR.cmd`. Después carga la configuración restaurada y desinstala
el complemento desde Plugins. La restauración conserva los demás ajustes;
no restaura una copia completa antigua de `config.toml`.

## Desarrollo

El plugin autocontenido está en `plugins/minimax-jdc`. El mercado del repositorio
está en `.agents/plugins/marketplace.json`. El ZIP incluye sólo el complemento.
No requiere dependencias npm: utiliza Node.js y PowerShell/.NET de Windows.

Ejecuta las pruebas con Node.js 22 o posterior:

```text
node --test tests/test_gateway.mjs tests/test_plugin.mjs
```

Las pruebas locales no necesitan credenciales. Las comprobaciones reales de
NVIDIA son optativas y no se ejecutan en CI. Los marcadores e imágenes de las
pruebas son fixtures de software, sin datos del usuario.

## Referencias

- [Formato e instalación local de plugins](https://developers.openai.com/plugins/build/plugins)
- [Compatibilidad de gateways con Codex](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)
- [MiniMax M3.1 Flash en NVIDIA](https://build.nvidia.com/minimaxai/minimax-m3.1-flash)
- [Condiciones y alcance de Free Endpoint](https://docs.api.nvidia.com/nim/docs/product)

Creado con el flujo de [Plugin Creator](https://developers.openai.com/plugins/build/plugins)
para ELUNIVERSODEJDC. Publicar este código en GitHub no lo publica en el directorio
universal de plugins ni demuestra su instalación en una cuenta de ChatGPT.
