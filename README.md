# ManuMCP

ManuMCP es un agente MCP local para conectar ChatGPT con tus carpetas de Windows. En la instalación predeterminada autoriza el Escritorio real, Descargas y todo el perfil del usuario; así puede trabajar en `workspace:/`, `downloads:/` y `pc:/` sin depender de que Codex esté abierto. La raíz `pc:/` también se puede ampliar deliberadamente a una unidad como `C:\` al instalar, manteniendo las exclusiones de seguridad. Permite consultar archivos de texto y preparar cambios acotados desde un cliente MCP remoto, manteniendo el proceso en tu PC.

La base de seguridad es deliberadamente pequeña: raíces explícitas, acceso únicamente a archivos de texto, límites de tamaño, bloqueo de secretos, rechazo de symlinks y hard links, y escrituras en dos fases. ManuMCP no es un escritorio remoto y no puede ejecutar comandos, abrir programas, mover el ratón, pulsar teclas ni leer el disco del sistema fuera de las raíces autorizadas.

## Qué resuelve y qué no

Cuando el ordenador está encendido, no está suspendido, tiene red y el agente/túnel están activos, el flujo es:

```text
ChatGPT web o la superficie compatible de tu cuenta
        │ MCP por túnel HTTPS privado
        ▼
ManuMCP --stdio en tu PC
        │
        ├── workspace:/  → %USERPROFILE%\Desktop
        ├── downloads:/  → %USERPROFILE%\Downloads
        └── pc:/         → %USERPROFILE% (perfil de usuario)
```

Cerrar Codex no detiene este flujo. En Windows, la instalación registra una tarea programada de usuario para arrancar el agente al iniciar sesión. El túnel privado se configura aparte porque necesita asociarse a una cuenta y workspace de OpenAI.

No se debe confundir “trabajar en mi ordenador” con control total de la interfaz. La versión incluida controla, de forma acotada, archivos de texto dentro de las tres raíces autorizadas; `pc:/` cubre cualquier carpeta de la raíz configurada, que por defecto es el perfil del usuario e incluye Documentos, Escritorio y Descargas. Si se configura `C:\`, cubre las carpetas normales de esa unidad, pero sigue bloqueando credenciales, datos de sesión, AppData y directorios del sistema. Esa frontera evita convertir un enlace de ChatGPT en una puerta para ejecutar malware o exfiltrar credenciales.

## Herramientas MCP

| Herramienta | Uso | Escribe |
| --- | --- | --- |
| `get_device_health` | Comprueba que el agente está activo y muestra su modo | No |
| `list_workspace` | Lista archivos y carpetas con profundidad y presupuesto limitados | No |
| `read_workspace_file` | Lee texto UTF-8 con líneas numeradas, hash y paginación | No |
| `search_workspace` | Busca texto dentro del workspace | No |
| `create_workspace_directory` | Propone y luego crea una carpeta | Sí, con confirmación |
| `create_workspace_file` | Propone y luego crea un archivo de texto | Sí, con confirmación |
| `replace_workspace_text` | Propone un reemplazo de líneas usando un hash de precondición | Sí, con confirmación |
| `apply_workspace_patch` | Propone y luego aplica un parche unificado | Sí, con confirmación |

Las herramientas de escritura nunca aplican el primer pedido directamente. Primero devuelven una vista previa y un token de corta duración. La aplicación requiere repetir los argumentos, el token y `confirmed: true`; además, el servidor consume cada token una sola vez y vuelve a comprobar el archivo antes de escribir.

## Requisitos

- Windows 10/11 con Node.js **22.12 o posterior**.
- PowerShell 5.1 o PowerShell 7 para los scripts de instalación.
- Para el túnel privado: acceso al producto Secure MCP Tunnel de OpenAI, permisos de organización/workspace y el `tunnel-client` oficial.
- Para la alternativa temporal: `ngrok` instalado y autenticado.

## Instalar en Windows

Desde una copia del repositorio:

```powershell
git clone https://github.com/ma-nucho-pro/ManuMCP.git
Set-Location ManuMCP
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

El instalador:

1. instala exactamente las dependencias del lockfile y compila `dist`;
2. crea `%USERPROFILE%\Desktop` y `%USERPROFILE%\Downloads` si no existen, y usa también `%USERPROFILE%` como raíz `pc:/`;
3. genera, una sola vez, el token local en `%APPDATA%\ManuMCP\local-token.txt`;
4. registra la tarea de usuario `ManuMCP Agent` y la inicia;
5. guarda las tres rutas no secretas en `%APPDATA%\ManuMCP\roots.json` para que el agente y el túnel usen exactamente la misma configuración;
6. deja los logs en `%APPDATA%\ManuMCP\logs\agent.log`.

La tarea usa el PowerShell del sistema y la instalación de Node.js detectada, no el runtime de Codex. También puede iniciar el agente con batería, no tiene límite de duración y está configurada para reintentarlo si el proceso termina.

El endpoint HTTP local queda en `http://127.0.0.1:8787/mcp` y exige el token Bearer. Solo escucha en loopback. El token no se guarda en el repositorio ni se muestra en los logs. El túnel privado usa el transporte stdio y mantiene las mismas raíces de Escritorio, Descargas y perfil de usuario.

Para ejecutarlo de forma visible durante una prueba:

```powershell
.\scripts\start-windows.ps1 -Foreground
```

La instalación predeterminada usa el Escritorio, Descargas y `%USERPROFILE%`. Si necesitas cambiar alguna raíz, puedes pasarla explícitamente; el túnel reutilizará esa configuración guardada. Para autorizar deliberadamente la unidad del sistema como raíz amplia de archivos, usa `-PcRoot "C:\"`; esta opción no habilita shell ni control de ventanas y las exclusiones de seguridad siguen activas:

```powershell
.\scripts\install-windows.ps1 -PcRoot "C:\"
```

También puedes configurar una raíz distinta y más estrecha, por ejemplo `-Downloads "D:\Mis descargas" -PcRoot "D:\Mis archivos"`.

Para quitar únicamente la tarea automática, sin borrar archivos, workspace ni token:

```powershell
.\scripts\uninstall-windows.ps1
```

## Conectar con ChatGPT mediante túnel privado

La opción recomendada es el Secure MCP Tunnel oficial de OpenAI. Su cliente crea una conexión saliente desde tu ordenador, por lo que no tienes que abrir un puerto entrante en el router o firewall. La guía oficial describe la creación del túnel, el runtime API key, `tunnel-client init`, `doctor` y `run`:

<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

El comando MCP que debe ejecutar el túnel es el transporte stdio de ManuMCP:

```text
node C:\ruta\a\ManuMCP\dist\app\server.js --stdio
```

En Windows puedes preparar y ejecutar el cliente con el helper incluido. Primero define la runtime key solo en la sesión actual y sustituye el `tunnel_id` real:

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\scripts\run-openai-tunnel.ps1 -TunnelId "tunnel_..."
```

El helper ejecuta `tunnel-client init --sample sample_mcp_stdio_local`, `doctor` y `run` con el comando stdio de ManuMCP. Descarga `tunnel-client` desde Platform tunnel settings o su release oficial; no pongas la runtime API key dentro de este repositorio ni en una tarea programada sin un almacén de secretos. El agente stdio no abre un servidor HTTP público y no necesita el token local.

Para que el túnel vuelva a arrancar al iniciar sesión en Windows, después de crear el perfil puedes instalar la tarea automática con la clave presente solo en la sesión actual:

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\scripts\install-tunnel-windows.ps1 -TunnelId "tunnel_..." -Profile "manumcp-final" -ClientPath "C:\ruta\a\tunnel-client.exe"
$env:CONTROL_PLANE_API_KEY = $null
```

El instalador guarda la clave únicamente como un secreto cifrado con Windows DPAPI para el usuario actual, limita el archivo al usuario actual y registra `ManuMCP Tunnel` para iniciarlo al iniciar sesión. No la escribe en el repositorio ni en los argumentos de la tarea. Para revisar el estado:

```powershell
Get-ScheduledTask -TaskName "ManuMCP Agent", "ManuMCP Tunnel"
& "C:\ruta\a\tunnel-client.exe" runtimes status manumcp --json
```

La tarea solo puede funcionar mientras el usuario de Windows pueda descifrar su credencial, la PC esté encendida/despierta y tenga red.

Una vez que el túnel esté creado y asociado al workspace correcto:

1. abre ChatGPT y activa Developer mode según la documentación de tu cuenta;
2. en la sección de Apps/Plugins compatible, pulsa `+`;
3. selecciona la opción de túnel, elige el túnel disponible y conéctalo;
4. prueba primero `get_device_health`, luego `list_workspace` y finalmente una escritura pequeña.

La documentación oficial de la integración MCP y del endpoint `/mcp` está aquí:

<https://developers.openai.com/plugins/build/app-quickstart>

La documentación de OpenAI también advierte que los servidores MCP remotos pueden recibir datos sensibles y que conviene exigir aprobación para acciones de escritura:

<https://developers.openai.com/api/docs/guides/tools-connectors-mcp>

La visibilidad del túnel depende de que esté asociado al workspace y permisos correctos. Este repositorio no puede crear por sí solo una conexión en tu cuenta ni inventar una runtime API key.

## Alternativa temporal con ngrok

La alternativa es útil para probar desde ChatGPT cuando no tengas acceso al túnel privado, pero la URL es pública y temporal. Instala y autentica ngrok por separado y ejecuta:

```powershell
.\scripts\start-ngrok.ps1
```

El script arranca o reutiliza el agente local y muestra la URL HTTPS resultante con `/mcp` junto con el token Bearer que debes configurar en la autenticación de la app MCP. Copia la URL y configura el token como Bearer en ChatGPT; nunca lo pongas en la URL. La URL cambia al reiniciar ngrok y esta opción no debe usarse para datos sensibles.

## Límites importantes

- `workspace:/` y `desktop:/` corresponden al Escritorio real (`%USERPROFILE%\Desktop`); `downloads:/` y `descargas:/` corresponden a Descargas; `pc:/` corresponde a la raíz configurada por `MANUMCP_PC_ROOT` (por defecto `%USERPROFILE%`) y permite cualquier carpeta que no esté excluida por la política de seguridad.
- Las rutas se expresan normalmente como `pc:/Documents/archivo.txt`, `downloads:/archivo.txt` o `workspace:/carpeta/archivo.txt`. También se aceptan rutas absolutas de Windows que estén dentro de esas raíces y se convierten a su alias seguro; se siguen rechazando UNC, `..`, URI, dispositivos y alias ajenos.
- Un nombre sin raíz (por ejemplo `hola mundo`) conserva el valor predeterminado de Escritorio; `Documents/...` se interpreta como `pc:/Documents/...`, y `Downloads/...` como `downloads:/...`.
- Las raíces se pueden cambiar mediante `MANUMCP_WORKSPACE`, `MANUMCP_DOWNLOADS` y `MANUMCP_PC_ROOT`; el instalador de Windows también acepta `-PcRoot "C:\"` para una raíz amplia de la unidad del sistema.
- Se bloquean `.mcpignore`, credenciales conocidas, claves privadas, tokens, `.env`, `AppData`, colmenas de registro del perfil (`NTUSER.*`/`UsrClass.dat*`), `node_modules`, `.git/objects`, `dist`, `build`, `.next`, `coverage` y otros patrones de riesgo.
- El perfil por defecto es `edit_safe`; se puede usar `MANUMCP_PROFILE=read_only` para exponer únicamente lectura.
- Los tamaños de lectura/escritura, líneas, profundidad, concurrencia y tiempo de operación son finitos.
- No hay `exec`, shell, PowerShell remoto, descarga de URLs, apertura de programas, control de navegador ni control de teclado/ratón. El acceso a `pc:/` permite archivos y carpetas de texto autorizados de la raíz configurada, no manejar ventanas ni aplicaciones.
- El ordenador debe estar encendido y despierto; “instalado” no significa que funcione cuando está apagado o sin conexión.
- La documentación actual de OpenAI indica que las apps MCP están disponibles solo en la web, no en móvil. Por tanto, esta implementación no puede cumplir una conexión MCP desde la app móvil; úsala desde ChatGPT web. La compatibilidad completa con acciones de escritura también depende del plan y del workspace: OpenAI la documenta para Business y Enterprise/Edu, mientras que Pro queda limitado a lectura/obtención en este flujo. Consulta la disponibilidad vigente en tu cuenta antes de publicar.

Referencia oficial de disponibilidad y permisos: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

## Desarrollo y verificación

```powershell
npm ci --ignore-scripts
npm run check
node scripts/verify-package.mjs
npm audit --audit-level=low
```

`npm run check` cubre el núcleo, la autenticación HTTP, el flujo de confirmación de escrituras, el bloqueo de traversal/secretos y el transporte stdio. La prueba del socket Unix del proyecto original se conserva en plataformas POSIX y se omite en Windows porque ese ejemplo no es el transporte usado por ManuMCP.

## Origen y licencia

ManuMCP parte del núcleo open source de [tunnelgpt-mcp-core](https://github.com/carlosrodera/tunnelgpt-mcp-core), conservando sus avisos MIT y sus primitivas de autorización, lectura segura, búsqueda y escritura atómica. La capa `src/app` añade el agente Windows, el endpoint MCP oficial por HTTP/stdio, la configuración de las raíces de Escritorio, Descargas y perfil de usuario, y los scripts de instalación.

Este repositorio está bajo la licencia [MIT](LICENSE). ManuMCP no es un producto oficial de OpenAI y no concede por sí mismo acceso a la cuenta de ChatGPT.
