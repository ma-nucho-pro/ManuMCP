# ManuMCP

<p align="center">
  <strong>Conecta un agente MCP con tu ordenador completo.</strong><br>
  ChatGPT web, Codex, Claude Code, Gemini CLI, Cursor y cualquier cliente compatible pueden trabajar con archivos, aplicaciones y procesos; en Windows y macOS también pueden controlar la interfaz gráfica cuando ManuMCP está ejecutándose localmente.
</p>

<p align="center">
  <a href="https://github.com/ma-nucho-pro/ManuMCP/actions/workflows/ci.yml"><img src="https://github.com/ma-nucho-pro/ManuMCP/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.12-339933.svg" alt="Node.js 22.12 o posterior"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-7c3aed.svg" alt="Model Context Protocol"></a>
  <a href="https://m8ven.ai/mcp/ma-nucho-pro-manumcp-1kbdcq"><img src="https://m8ven.ai/badge/mcp/ma-nucho-pro-manumcp-1kbdcq" alt="M8ven Score"></a>
</p>

> [!IMPORTANT]
> ManuMCP es un servidor MCP local. No es un bypass de seguridad ni un servicio de administración remota. Ejecuta acciones con los permisos del usuario que inició sesión, y las operaciones que cambian el equipo pasan por una vista previa y una confirmación de un solo uso.

## Qué hace

ManuMCP mantiene un agente en tu ordenador y le ofrece a tu cliente de IA herramientas para:

- trabajar en el Escritorio, Descargas o cualquier carpeta accesible de la máquina;
- descubrir y usar otras unidades Windows montadas como `pc-d:/`, `pc-f:/`, etc.;
- abrir Word, navegadores, editores y otras aplicaciones;
- consultar y terminar procesos;
- enumerar, enfocar y cerrar ventanas en Windows/macOS;
- leer pantallas, mover el ratón, escribir texto y pulsar combinaciones de teclas en Windows/macOS;
- ejecutar PowerShell/CMD en Windows o `sh`, `bash` y `zsh` en macOS/Linux;
- funcionar sin que Codex permanezca conectado, mientras el agente y el túnel sigan activos.

La idea central es que `pc:/` representa el ordenador completo, no solamente una carpeta del proyecto:

| Plataforma | Raíz completa | Otras unidades |
| --- | --- | --- |
| Windows | `pc:/` apunta por defecto a la raíz de la unidad del sistema (`C:\`) | Cada unidad montada y accesible se descubre como `pc-d:/`, `pc-f:/`, etc. |
| macOS | `pc:/` apunta por defecto a `/` | Los discos montados aparecen bajo `pc:/Volumes/<nombre>` |
| Linux | `pc:/` apunta por defecto a `/` | Los puntos de montaje están dentro de `pc:/` cuando el usuario puede leerlos |

Además existen los alias cómodos `workspace:/` y `desktop:/` para el Escritorio, y `downloads:/` y `descargas:/` para Descargas. Una ruta sin alias, como `hola mundo.txt`, continúa teniendo por defecto el Escritorio para evitar sorpresas.

La capa de archivos mantiene una política no reducible: bloquea credenciales, claves privadas, tokens, archivos `.env`, almacenes de configuración sensibles, enlaces simbólicos, hard links y carpetas críticas del sistema. El shell confirmado es deliberadamente más potente y puede tocar cualquier recurso que el usuario del proceso pueda tocar; revisa su vista previa.

## Cómo funciona

~~~text
ChatGPT web / Codex / Claude Code / Gemini CLI / Cursor / otro cliente MCP
                         │
             stdio local o túnel MCP seguro
                         ▼
              ManuMCP en tu ordenador
                         │                 │
       archivos y comandos      escritorio gráfico (Windows/macOS)
     pc:/, pc-d:/, workspace:/   ventanas, pantalla, ratón, teclado
~~~

<p align="center">
  <img src="docs/assets/manumcp-architecture.svg" alt="Diagrama de arquitectura: clientes MCP conectan con el agente local ManuMCP y pasan por confirmación antes de acceder a archivos, comandos o escritorio gráfico" width="100%">
</p>

En Windows, el instalador registra `ManuMCP Agent` en el Programador de tareas. En macOS instala un `LaunchAgent`; en Linux intenta instalar un servicio systemd de usuario y, si no está disponible, mantiene un proceso de usuario con reinicio manual. El agente se inicia cuando la sesión del usuario está disponible.

Para que ChatGPT web llegue a ese agente desde fuera de la red local hace falta mantener activo un túnel saliente. ManuMCP incluye helpers para el Secure MCP Tunnel de OpenAI y para stdio; la credencial del túnel es específica de tu cuenta y nunca se inventa ni se publica en este repositorio.

## Requisitos

### Todos los sistemas

- Node.js **22.12 o posterior** y npm.
- Git si vas a clonar el repositorio.
- Un cliente MCP que admita transporte stdio, o un cliente remoto que admita el túnel MCP.
- Una sesión de usuario activa y el ordenador encendido/despierto para el control gráfico.

### Windows

- Windows 10 u 11.
- PowerShell 5.1 o PowerShell 7.
- Para ventanas, pantalla, ratón y teclado: una sesión gráfica interactiva. No hace falta ejecutar el instalador como administrador.

### macOS

- macOS con Node.js instalado.
- Para controlar ventanas y entrada: concede a la aplicación que ejecuta Node/ManuMCP los permisos de **Accessibility**.
- Para `capture_screen`: concede **Screen Recording**. macOS puede pedir cerrar y volver a abrir la aplicación después del cambio.

### Linux

- Linux con Node.js instalado.
- Se admiten archivos, comandos, procesos y apertura de elementos con los permisos del usuario.
- El backend de control gráfico de ventanas, pantallas, ratón, escritura y atajos todavía no está implementado en Linux; esas herramientas devuelven una respuesta de plataforma no compatible.

### ChatGPT web

- Acceso de tu cuenta al modo de desarrollador y a apps MCP personalizadas.
- Un túnel Secure MCP de OpenAI creado y asociado al workspace correcto, más el `tunnel-client` oficial.
- La app MCP debe actualizarse después de cambiar el catálogo de herramientas.

> [!NOTE]
> Instalar ManuMCP en Codex, Claude Code, Gemini CLI o Cursor no instala automáticamente una app dentro de tu cuenta de ChatGPT: son configuraciones distintas. El instalador puede preparar el agente local y los clientes MCP detectados; la parte de ChatGPT web debe completarse en el navegador con la cuenta propietaria y su autorización.

## Instalación rápida

### Windows

En PowerShell:

~~~powershell
git clone https://github.com/ma-nucho-pro/ManuMCP.git
Set-Location ManuMCP
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
~~~

El instalador instala las dependencias del lockfile, compila `dist`, crea el Escritorio y Descargas si hacen falta, genera un token local, guarda las raíces en `%APPDATA%\ManuMCP\roots.json` y deja el agente respondiendo en `http://127.0.0.1:8787/healthz`.

Sin parámetros, `pc:/` se configura como la raíz de la unidad donde está Windows. Si prefieres una raíz diferente o más estrecha:

~~~powershell
.\scripts\install-windows.ps1 -PcRoot "D:\Mis archivos"
~~~

Para autorizar explícitamente la unidad del sistema completa:

~~~powershell
.\scripts\install-windows.ps1 -PcRoot "C:\"
~~~

El valor predeterminado ya cubre `C:\` y ManuMCP descubre otras letras de unidad montadas y accesibles. No se crean ni se autorizan letras que no existan.

Instalación desde una terminal sin clonar antes:

~~~powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/ma-nucho-pro/ManuMCP/main/scripts/bootstrap-windows.ps1).Content))
~~~

Para que un agente prepare también los clientes MCP instalados y abra la pantalla de configuración de ChatGPT web:

~~~powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/ma-nucho-pro/ManuMCP/main/scripts/bootstrap-windows.ps1).Content)) -Clients auto -OpenChatGPT
~~~

Si una ruta llamada `ManuMCP` ya existe y no es un repositorio Git, el bootstrap se detiene y no la sobrescribe. Para máxima trazabilidad, clona el repositorio y ejecuta el instalador visible.

### macOS y Linux

En una terminal:

~~~bash
git clone https://github.com/ma-nucho-pro/ManuMCP.git
cd ManuMCP
bash scripts/install-unix.sh
~~~

El instalador crea `~/Desktop` y `~/Downloads` si no existen, usa `/` como `pc:/` por defecto, genera el token local en `~/.config/manumcp/local-token.txt`, compila el servidor e instala el arranque del agente:

- macOS: `~/Library/LaunchAgents/com.manumcp.agent.plist`;
- Linux con systemd: `~/.config/systemd/user/manumcp.service`;
- Linux sin systemd de usuario: proceso de usuario y log en `~/.config/manumcp/logs/`.

También puedes usar el bootstrap:

~~~bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/ManuMCP/main/scripts/bootstrap-unix.sh)"
~~~

Para que el bootstrap configure también los clientes MCP detectados y abra ChatGPT web:

~~~bash
MANUMCP_CLIENTS=auto MANUMCP_OPEN_CHATGPT=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/ManuMCP/main/scripts/bootstrap-unix.sh)"
~~~

El bootstrap no sobrescribe una carpeta existente que no sea un repositorio Git. Si necesitas una raíz más estrecha:

~~~bash
MANUMCP_PC_ROOT="$HOME" bash scripts/install-unix.sh
~~~

Comprueba que el agente quedó activo:

~~~bash
curl -fsS http://127.0.0.1:8787/healthz
~~~

La respuesta debe incluir `ok: true`, `pc:/ (raíz completa del equipo)` y el transporte `http`.

## Instalación completa guiada por una IA

El flujo recomendado para Codex, Claude Code, Gemini CLI, Cursor u otro agente con terminal es:

1. Leer este README completo y detectar el sistema operativo, el cliente MCP instalado y si el cliente tiene navegador/computer-use.
2. Ejecutar el bootstrap del sistema operativo. El bootstrap instala dependencias del proyecto, compila `dist`, crea el arranque del agente, comprueba `/healthz` y ejecuta `configure-clients.mjs --client auto`.
3. Si el cliente no estaba instalado, conservar el comando stdio y mostrarlo como configuración pendiente; no inventar una instalación ni reemplazar otro cliente.
4. Si el cliente ya tenía una entrada llamada `manumcp`, dejarla intacta o usar `--replace` solo cuando el usuario pidió actualizarla. Cursor conserva los demás servidores y crea un respaldo antes de modificar su JSON.
5. Si el agente tiene navegador/computer-use, abrir `https://chatgpt.com/#settings/Apps`, comprobar que la cuenta y el workspace son los del propietario, y completar el flujo de Developer mode: crear o actualizar la app, seleccionar el túnel de ManuMCP, usar **Scan Tools** y guardar. Si la app ya existe, pulsar **Actualizar/Refresh** para redescubrir el catálogo.
6. Si ChatGPT solicita inicio de sesión, una clave, autorización de cuenta/workspace o permisos del sistema, detenerse exactamente en ese paso para que el propietario lo haga. El agente nunca debe pedir, copiar, registrar ni subir contraseñas, cookies o claves privadas.
7. Verificar por separado el cliente local con `tools/list` y ChatGPT web con `get_device_health`, `list_storage_volumes` y una lectura pequeña de `pc:/`. No declarar la instalación completa si una de esas comprobaciones falla.

El comando unificado, después de clonar el repositorio, es:

~~~text
npm run configure-clients -- --client auto --open-chatgpt
~~~

Para actualizar únicamente la entrada `manumcp` de los clientes que ya la tienen:

~~~text
npm run configure-clients -- --client auto --replace
~~~

Para que un agente revise las acciones sin modificar nada:

~~~text
npm run configure-clients -- --client auto --dry-run
~~~

El configurador soporta `codex`, `claude`, `gemini`, `cursor`, `auto` y `none`. Con `auto` omite los clientes que no están instalados y devuelve un resumen JSON para que el agente sepa qué quedó configurado, qué ya estaba presente y qué requiere una acción manual.

### Prompt de instalación para otro agente

Puedes pegar este prompt en un agente que tenga terminal y, si hace falta, navegador/computer-use:

~~~text
Instala ManuMCP completamente en este ordenador y verifica cada etapa. Detecta Windows, macOS o Linux; clona https://github.com/ma-nucho-pro/ManuMCP si no está presente; ejecuta el bootstrap o instalador correcto; espera a que /healthz responda ok:true; ejecuta `node scripts/configure-clients.mjs --client auto --open-chatgpt`; y configura solo los clientes MCP que realmente estén instalados. Usa pc:/ para la raíz completa, workspace:/ para Escritorio y downloads:/ para Descargas. En el cliente local verifica `tools/list` y llama en solo lectura a get_device_health y list_storage_volumes. Después, si dispones de navegador o computer-use, abre https://chatgpt.com/#settings/Apps, usa la cuenta y workspace del propietario, crea o actualiza la app/túnel ManuMCP, pulsa Scan Tools/Actualizar y prueba desde un chat `get_device_health`, `list_storage_volumes` y una lectura pequeña de pc:/. No declares éxito hasta enseñar los resultados de la instalación local, la configuración de cada cliente y la prueba remota. Nunca pidas ni copies contraseñas, cookies, claves privadas o tokens a archivos; si ChatGPT requiere inicio de sesión, autorización, una clave del túnel, Developer mode o permisos de macOS/Windows, detente en ese paso y explica exactamente qué debe aceptar o introducir el propietario.
~~~

Ese prompt automatiza el servidor, el arranque y la configuración de los clientes locales. La parte de ChatGPT web no puede completarse de forma legítima con un comando de terminal porque requiere la sesión y la autorización del propietario; un agente con computer-use sí puede navegar hasta el formulario y dejarlo preparado, pero debe parar para el inicio de sesión o la aprobación que corresponda. No debe falsificar permisos, elevar UAC, desactivar protecciones ni copiar secretos a un repositorio.

## Configurar el cliente MCP local

El transporte stdio es la opción para Codex, Claude Code, Gemini CLI, Cursor y cualquier otro cliente compatible. Después de instalar el agente, la forma automática es:

~~~text
npm run configure-clients -- --client auto
~~~

Ese comando detecta los clientes que existen en el `PATH`, registra `manumcp` con el wrapper persistente y devuelve un resumen JSON. El modo `--replace` actualiza solo la entrada de ManuMCP; el modo `--dry-run` no ejecuta ni escribe nada. Si el cliente no ofrece una CLI detectable, usa la configuración manual de esta sección.

El comando directo mínimo es:

~~~text
node /ruta/ManuMCP/dist/app/server.js --stdio
~~~

Después de ejecutar el instalador, es mejor usar el wrapper persistente para conservar exactamente las raíces elegidas:

Windows:

~~~text
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File %APPDATA%\ManuMCP\stdio-entrypoint.ps1
~~~

macOS/Linux:

~~~text
bash /ruta/ManuMCP/scripts/stdio-entrypoint-unix.sh
~~~

### Codex

~~~bash
codex mcp add manumcp -- node /ruta/ManuMCP/dist/app/server.js --stdio
codex mcp list
~~~

Para que esté disponible en todos tus proyectos, usa el alcance de usuario que admita tu versión de Codex o configura la entrada en `~/.codex/config.toml`. En Windows puedes sustituir el comando por el wrapper de PowerShell.

### Claude Code

~~~bash
claude mcp add --transport stdio --scope user manumcp -- node /ruta/ManuMCP/dist/app/server.js --stdio
claude mcp list
~~~

En Windows nativo, si tu instalación necesita un wrapper de shell, usa:

~~~text
claude mcp add --transport stdio --scope user manumcp -- cmd /c powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\Users\TU_USUARIO\AppData\Roaming\ManuMCP\stdio-entrypoint.ps1
~~~

### Gemini CLI

~~~bash
gemini mcp add manumcp node /ruta/ManuMCP/dist/app/server.js --stdio --scope user
gemini mcp list
~~~

Si tu versión coloca las opciones antes del comando, ejecuta `gemini mcp add --help` y conserva el mismo nombre, ejecutable y argumentos.

### Cursor

Cursor usa `mcp.json`. Para una configuración global, edita o combina esta entrada en `~/.cursor/mcp.json`; para una sola carpeta usa `.cursor/mcp.json`. Combina el objeto con el archivo existente, no borres otros servidores:

~~~json
{
  "mcpServers": {
    "manumcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/ruta/ManuMCP/dist/app/server.js", "--stdio"]
    }
  }
}
~~~

En Cursor también puedes añadir el servidor desde Customize > MCPs o comprobarlo con `agent mcp list`.

### Otros clientes

Todo cliente MCP que implemente stdio puede iniciar el mismo comando. Si requiere JSON, la forma estándar es:

~~~json
{
  "mcpServers": {
    "manumcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/ruta/ManuMCP/dist/app/server.js", "--stdio"]
    }
  }
}
~~~

La compatibilidad depende del cliente: ManuMCP no puede modificar configuraciones de una aplicación que no está instalada ni saltarse su modelo de aprobaciones.

## Conectar ChatGPT web mediante Secure MCP Tunnel

ChatGPT web no lee la configuración local de Codex ni puede arrancar un proceso en tu ordenador por sí solo. Para llegar a ManuMCP desde un chat remoto, crea/asocia un Secure MCP Tunnel de OpenAI y haz que su comando stdio inicie ManuMCP.

La guía oficial del túnel es:

<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

### Windows

Define la runtime key solo en la sesión actual y sustituye el identificador real del túnel:

~~~powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\scripts\run-openai-tunnel.ps1 -TunnelId "tunnel_..."
~~~

El helper ejecuta `init`, `doctor` y `run`. Para instalar el arranque automático del túnel:

~~~powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
.\scripts\install-tunnel-windows.ps1 -TunnelId "tunnel_..." -ClientPath "C:\ruta\a\tunnel-client.exe"
$env:CONTROL_PLANE_API_KEY = $null
~~~

La clave queda protegida con DPAPI para el usuario actual. La tarea `ManuMCP Tunnel` solo puede ejecutarse cuando Windows puede descifrarla, hay una sesión válida y existe red.

### macOS/Linux

Después de instalar el agente y descargar `tunnel-client`:

~~~bash
export CONTROL_PLANE_API_KEY="sk-..."
MANUMCP_TUNNEL_CLIENT="/ruta/tunnel-client" bash scripts/install-tunnel-unix.sh tunnel_0123456789abcdef0123456789abcdef
unset CONTROL_PLANE_API_KEY
~~~

En macOS la clave se guarda en el llavero del usuario. En Linux se guarda en un archivo con permisos `600`. El helper instala `com.manumcp.tunnel.plist` o `manumcp-tunnel.service` y ejecuta el wrapper stdio de ManuMCP.

La clave de runtime y el identificador del túnel son secretos/configuración de tu cuenta: no los subas al repositorio, no los pongas en una URL y no los pegues en el README.

### Activarlo en ChatGPT

1. Abre ChatGPT en la web con la cuenta y workspace correctos.
2. Activa Developer mode si tu cuenta lo permite.
3. Añade la app MCP o el túnel desde la sección de Apps/Plugins.
4. Selecciona el túnel asociado a ese workspace y completa la autorización.
5. Si cambiaste herramientas, pulsa **Actualizar/Refresh** para que ChatGPT reciba el catálogo nuevo.
6. Prueba `get_device_health`, que incluye el inventario de unidades, después `list_storage_volumes` o su alias `get_storage_volumes` y finalmente una operación pequeña.

La disponibilidad de acciones de escritura y control depende también de la cuenta, el plan, el workspace y las políticas del cliente ChatGPT. ManuMCP no puede habilitar por código una acción que ChatGPT haya ocultado o bloqueado; si el cliente solo ofrece lectura/fetch, el servidor seguirá funcionando pero no podrá recibir escrituras, comandos o control gráfico desde ese chat. Consulta la [documentación de Developer mode y MCP apps](https://help.openai.com/en/articles/12584461) para las reglas vigentes de tu cuenta.

#### Qué puede hacer un agente con navegador

Un agente que tenga browser-use o computer-use puede abrir la página de Apps, comprobar el estado de la app y pulsar **Crear**, **Scan Tools**, **Actualizar/Refresh** y **Guardar**. También puede seleccionar `ManuMCP` en un chat y ejecutar las pruebas de solo lectura. No puede ni debe iniciar sesión con credenciales que el usuario le entregue, leer cookies, recuperar una clave oculta del navegador o aprobar permisos en nombre del propietario.

Cuando el navegador muestre un formulario de inicio de sesión, una autorización del workspace, una clave de `CONTROL_PLANE_API_KEY`, una aprobación del túnel o un permiso del sistema operativo, el flujo queda pausado para que el propietario lo complete. Después el agente puede continuar con la sincronización y la prueba. Esto es una condición de seguridad y de la cuenta, no un fallo del instalador.

Un agente sin navegador no puede instalar una app dentro de ChatGPT solo ejecutando comandos locales: puede dejar preparado el agente, el túnel y la configuración stdio, e imprimir el enlace `https://chatgpt.com/#settings/Apps` para que el propietario termine la conexión.

Para usarlo desde un teléfono, abre ChatGPT web en el navegador y comprueba la disponibilidad de tu cuenta. La documentación actual de OpenAI indica que las apps MCP personalizadas se conectan desde la web y no desde la aplicación móvil nativa; el túnel puede seguir corriendo en tu PC, pero el cliente móvil nativo no se debe presentar como compatible sin soporte oficial.

## Navegador y computer-use

ManuMCP no pretende ser una extensión del navegador ni sustituye la capacidad de browser-use de cada cliente. Expone el control del escritorio local para que un agente que ya tiene visión/computer-use pueda combinarlo con MCP:

1. `list_windows` identifica la ventana y el proceso.
2. `capture_screen` obtiene una imagen de la pantalla.
3. `focus_window` activa la aplicación.
4. `control_mouse`, `type_text` y `press_hotkey` interactúan con la interfaz.
5. `launch_application` puede iniciar Word, Edge, Chrome, Safari u otra aplicación instalada.
6. `open_url` abre una URL HTTP/HTTPS en el navegador predeterminado; después el agente puede observar y operar esa ventana con las herramientas anteriores.

Por ejemplo, en Windows/macOS el cliente puede abrir Word con `launch_application`, usar `list_windows` para localizarlo y escribir en el documento. Para abrir un archivo existente se usa `open_item`. En Linux puede abrir aplicaciones o documentos, pero no controlar gráficamente sus ventanas mediante las herramientas de ManuMCP. El cliente sigue siendo responsable de sus propias capacidades de navegador, visión y confirmación.

En macOS y Linux, una respuesta correcta de `open_url` confirma que el sistema entregó la URL a `/usr/bin/open` o `xdg-open`; no garantiza que el navegador haya terminado de cargar la página. Linux necesita una sesión gráfica activa y que `xdg-open` esté instalado.

## Herramientas disponibles

| Herramienta | Función | Cambia el equipo |
| --- | --- | --- |
| `get_device_health` | Estado, plataforma, perfil, raíces autorizadas e inventario de unidades | No |
| `list_storage_volumes` | Descubre unidades/volúmenes y aliases utilizables | No |
| `get_storage_volumes` | Alias de compatibilidad para obtener unidades/volúmenes | No |
| `list_workspace` | Lista archivos y carpetas con límites | No |
| `read_workspace_file` | Lee texto UTF-8 con paginación y hash | No |
| `search_workspace` | Busca texto dentro de una raíz autorizada | No |
| `create_workspace_directory` | Propone y crea una carpeta | Sí, confirmación |
| `create_workspace_file` | Propone y crea un archivo de texto | Sí, confirmación |
| `replace_workspace_text` | Reemplaza un rango usando hash de precondición | Sí, confirmación |
| `apply_workspace_patch` | Aplica un parche unificado usando hash | Sí, confirmación |
| `run_command` | PowerShell/CMD o sh/bash/zsh | Sí, confirmación |
| `launch_application` | Abre un ejecutable o aplicación instalada | Sí, confirmación |
| `open_item` | Abre un archivo/carpeta con la aplicación asociada | Sí, confirmación |
| `open_url` | Abre una URL HTTP/HTTPS en el navegador predeterminado | Sí, confirmación |
| `list_processes` | Lista procesos y memoria | No |
| `terminate_process` | Termina un proceso por PID | Sí, confirmación |
| `list_windows` | Lista ventanas visibles y la activa | No |
| `focus_window` | Activa una ventana | Sí, confirmación |
| `close_window` | Solicita el cierre normal de una ventana | Sí, confirmación |
| `get_screen_info` | Lista pantallas y coordenadas | No |
| `capture_screen` | Captura una pantalla o todas | No |
| `get_cursor_position` | Lee la posición del cursor | No |
| `control_mouse` | Mueve, pulsa o desplaza el ratón | Sí, confirmación |
| `type_text` | Escribe Unicode en la ventana activa | Sí, confirmación |
| `press_hotkey` | Envía una combinación de teclas | Sí, confirmación |

Las operaciones mutantes siguen siempre un flujo de dos llamadas: ManuMCP devuelve una vista previa con un token firmado de un solo uso, y la segunda llamada debe repetir los argumentos con `confirmed: true` y ese token. El token caduca y no se puede reutilizar.

## Límites y seguridad

- `pc:/` significa raíz completa del sistema configurada, pero no significa privilegios de administrador.
- En Windows se exponen solo letras de unidad montadas y accesibles en el momento en que arranca el agente. Si conectas una unidad después, reinicia el agente o vuelve a instalarlo para descubrirla.
- Un disco apagado, desmontado, cifrado o sin permisos no puede ser controlado por ningún MCP sin que el sistema operativo lo haga accesible.
- Los comandos se ejecutan como el usuario actual. ManuMCP no eleva UAC, no rompe permisos de macOS y no desactiva sandboxing de un cliente.
- `run_command` es un shell general: después de la confirmación puede leer o modificar cualquier recurso al que la cuenta de Windows tenga acceso. Las denegaciones de `AppData`, credenciales y otras rutas sensibles pertenecen a las herramientas de archivos y al directorio de trabajo; no convierten un shell general en una caja de arena.
- La política de archivos bloquea credenciales, `AppData`, `Windows`, `Program Files`, `ProgramData`, `System`, `Library`, `private`, `.ssh`, `.aws`, `.config`, `.git/objects` y otros destinos sensibles.
- La política de archivos rechaza enlaces simbólicos y hard links para evitar escapar de una raíz o tocar un archivo inesperado.
- Las capturas pueden contener contraseñas, correo, documentos y datos personales.
- El servidor HTTP solo escucha en loopback y exige token Bearer; el túnel recomendado usa stdio y una conexión saliente.
- Mantén el túnel detenido cuando no necesites control remoto y revisa las confirmaciones de acciones destructivas.
- “Instalación automática” significa que el script puede preparar el proceso, las dependencias y el arranque de usuario. No puede conceder silenciosamente permisos de Accessibility, Screen Recording, UAC, cuenta OpenAI, workspace MCP o autenticación del cliente.

## Verificación local

~~~bash
npm ci --ignore-scripts
npm run check
node scripts/verify-package.mjs
npm audit --audit-level=low
~~~

`npm run check` compila y ejecuta las pruebas del núcleo, autenticación HTTP, límites de rutas, bloqueo de secretos, escrituras confirmadas, transporte stdio y control de procesos/comandos. En Windows también ejecuta las comprobaciones nativas de ventanas, pantallas, cursor y entrada. En macOS ejecuta la prueba POSIX de comando, procesos y volumen; las comprobaciones gráficas requieren una sesión y permisos de Accessibility/Screen Recording. En Linux se validan archivos, comandos, procesos, volúmenes y apertura de elementos; el control gráfico todavía no está implementado.

## Desarrollo

~~~bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
~~~

La configuración se puede estrechar con `MANUMCP_WORKSPACE`, `MANUMCP_DOWNLOADS` y `MANUMCP_PC_ROOT`. `MANUMCP_PROFILE=read_only` desactiva todas las operaciones de control y escritura; `edit_safe` es el perfil por defecto.

## Proyecto y licencia

ManuMCP parte del núcleo open source de [tunnelgpt-mcp-core](https://github.com/carlosrodera/tunnelgpt-mcp-core) y conserva sus avisos MIT y sus primitivas de autorización, lectura segura, búsqueda y escritura atómica. La capa `src/app` añade el agente multiplataforma, el control de escritorio, el catálogo MCP HTTP/stdio, la detección de volúmenes y los instaladores.

Este repositorio está bajo la licencia [MIT](LICENSE). ManuMCP no es un producto oficial de OpenAI, Anthropic, Google ni Cursor.

## Autor

Hecho por [Roberto Manuel Jara Peche](https://github.com/ma-nucho-pro).

- GitHub: [@ma-nucho-pro](https://github.com/ma-nucho-pro)
- YouTube: [@ManuchoAI](https://www.youtube.com/@ManuchoAI)
- X: [@ManuchoAI](https://x.com/ManuchoAI)
- Instagram: [@robertmanuchojp](https://www.instagram.com/robertmanuchojp/)
- LinkedIn: [Roberto Manuel Jara Peche](https://www.linkedin.com/in/roberto-manuel-jara-peche-10867240b/)
