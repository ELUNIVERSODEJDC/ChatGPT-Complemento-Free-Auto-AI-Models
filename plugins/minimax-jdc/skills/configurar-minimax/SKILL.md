---
name: configurar-minimax
description: Configurar, comprobar o restaurar Auto Free de Kilo en el selector de Codex mediante el complemento JDC para Windows.
---

El identificador minimax-jdc y el nombre técnico de esta skill se conservan para actualizar la instalación anterior. El complemento visible es Auto Free para Codex JDC; ya no configura modelos de NVIDIA.

Para una petición expresa de activar Auto Free, usa configurar_auto_free del servidor MCP minimax-jdc. Para consultar el estado usa estado_auto_free. Para volver al proveedor anterior, sólo si el usuario lo pide, usa restaurar_proveedor antes de desinstalar.

No solicites claves NVIDIA ni Kilo: la ruta kilo-auto/free permite acceso anónimo. Nunca leas, descifres ni envíes una credencial histórica. No actives rutas de pago ni cambies el modelo de un chat por tu cuenta.

Si MCP no está cargado, ejecuta node con la ruta absoluta scripts/configure.mjs dentro de la raíz instalada. No invoques codex.exe, cambies ACL, políticas de ejecución ni servicios de Windows.

INSTALAR.cmd registra el complemento, verifica una respuesta real y reinicia Codex después de activar el proveedor. MCP y la configuración directa conservan el chat abierto; el reinicio directo requiere petición expresa. Elige Kilo Auto Free tras recargar el selector. Una prueba del catálogo no demuestra que la interfaz ya se haya actualizado.

El complemento conserva GPT y presenta una única ruta externa: kilo-auto/free. Kilo selecciona los modelos gratuitos disponibles; la selección y capacidades pueden variar. El catálogo consultado anuncia texto, herramientas y 256000 tokens de contexto; no anuncia imágenes ni razonamiento ajustable. No inventes búsquedas alojadas, resultados o compatibilidad universal.

El acceso anónimo tiene límites por IP. Los proveedores gratuitos pueden registrar consultas y usarlas para mejorar sus servicios; evita contenido confidencial. Consulta LEEME.txt. La integración es independiente y no es un producto oficial de Kilo ni de OpenAI.
