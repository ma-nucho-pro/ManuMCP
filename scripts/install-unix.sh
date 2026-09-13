#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
node_command="${MANUMCP_NODE:-$(command -v node || true)}"
npm_command="${MANUMCP_NPM:-$(command -v npm || true)}"

if [[ -z "$node_command" || ! -x "$node_command" ]]; then
    echo "ManuMCP necesita Node.js 22.12 o posterior. Instálalo y vuelve a ejecutar este script." >&2
    exit 1
fi
if [[ -z "$npm_command" || ! -x "$npm_command" ]]; then
    echo "ManuMCP necesita npm, incluido normalmente con Node.js." >&2
    exit 1
fi

if ! "$node_command" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1);'; then
    echo "La versión de Node.js debe ser 22.12 o posterior; encontrada: $("$node_command" --version)." >&2
    exit 1
fi

config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
log_directory="$config_directory/logs"
mkdir -p "$config_directory" "$log_directory"
chmod 700 "$config_directory" "$log_directory"
node_path_file="$config_directory/node-path.txt"
printf '%s\n' "$node_command" > "$node_path_file"
chmod 600 "$node_path_file"

workspace_path="${MANUMCP_WORKSPACE:-$HOME/Desktop}"
downloads_path="${MANUMCP_DOWNLOADS:-$HOME/Downloads}"
pc_root="${MANUMCP_PC_ROOT:-/}"
mkdir -p "$workspace_path" "$downloads_path" "$pc_root"

echo "Instalando dependencias y compilando ManuMCP..."
cd "$project_root"
"$npm_command" ci --ignore-scripts
"$npm_command" run build

token_path="$config_directory/local-token.txt"
if [[ ! -s "$token_path" ]]; then
    "$node_command" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > "$token_path"
fi
chmod 600 "$token_path"

roots_path="$config_directory/roots.json"
project_path_file="$config_directory/project-root.txt"
"$node_command" -e 'const fs = require("node:fs"); const [rootsPath, projectPath, workspace, downloads, pcRoot, projectRoot] = process.argv.slice(1); fs.writeFileSync(rootsPath, JSON.stringify({ workspace, downloads, pcRoot }) + "\n", { mode: 0o600 }); fs.writeFileSync(projectPath, projectRoot + "\n", { mode: 0o600 });' "$roots_path" "$project_path_file" "$workspace_path" "$downloads_path" "$pc_root" "$project_root"
chmod 600 "$roots_path" "$project_path_file"

start_script="$project_root/scripts/start-unix.sh"
pid_path="$config_directory/agent.pid"
service_mode=""

if [[ "$(uname -s)" == "Darwin" ]]; then
    launch_agents="$HOME/Library/LaunchAgents"
    mkdir -p "$launch_agents"
    plist_path="$launch_agents/com.manumcp.agent.plist"
    "$node_command" -e 'const fs = require("node:fs"); const [file, shell, script, root, config, out, err] = process.argv.slice(1); const esc = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const item = value => "<string>" + esc(value) + "</string>"; const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.manumcp.agent</string>\n<key>ProgramArguments</key><array>" + item(shell) + item(script) + "</array>\n<key>WorkingDirectory</key>" + item(root) + "\n<key>EnvironmentVariables</key><dict><key>MANUMCP_CONFIG_DIR</key>" + item(config) + "</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key>" + item(out) + "\n<key>StandardErrorPath</key>" + item(err) + "\n</dict></plist>\n"; fs.writeFileSync(file, xml, { mode: 0o600 });' "$plist_path" "/bin/bash" "$start_script" "$project_root" "$config_directory" "$log_directory/agent.log" "$log_directory/agent-error.log"
    launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist_path"
    launchctl kickstart -k "gui/$(id -u)/com.manumcp.agent"
    service_mode="launchd"
else
    systemd_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    service_path="$systemd_directory/manumcp.service"
    mkdir -p "$systemd_directory"
    {
        printf '%s\n' '[Unit]' 'Description=ManuMCP local computer agent' 'After=network-online.target' '' '[Service]' 'Type=simple'
        printf 'WorkingDirectory="%s"\n' "$project_root"
        printf 'ExecStart=/bin/bash "%s"\n' "$start_script"
        printf 'Environment="MANUMCP_CONFIG_DIR=%s"\n' "$config_directory"
        printf '%s\n' 'Restart=on-failure' 'RestartSec=2' '' '[Install]' 'WantedBy=default.target'
    } > "$service_path"
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now manumcp.service >/dev/null 2>&1; then
        service_mode="systemd-user"
    else
        if [[ -s "$pid_path" ]]; then
            old_pid="$(tr -dc '0-9' < "$pid_path" || true)"
            if [[ -n "$old_pid" ]]; then kill "$old_pid" >/dev/null 2>&1 || true; fi
        fi
        nohup /bin/bash "$start_script" >> "$log_directory/agent.log" 2>> "$log_directory/agent-error.log" < /dev/null &
        printf '%s\n' "$!" > "$pid_path"
        chmod 600 "$pid_path"
        service_mode="background"
    fi
fi

ready="false"
for ((attempt = 0; attempt < 40; attempt += 1)); do
    if "$node_command" -e 'fetch("http://127.0.0.1:8787/healthz").then(async response => { if (!response.ok || (await response.json()).ok !== true) process.exit(1); }).catch(() => process.exit(1));'; then
        ready="true"
        break
    fi
    sleep 0.5
done

if [[ "$ready" != "true" ]]; then
    echo "El servicio se instaló, pero ManuMCP no respondió en http://127.0.0.1:8787/healthz." >&2
    echo "Revisa $log_directory/agent.log y $log_directory/agent-error.log." >&2
    exit 1
fi

echo "ManuMCP está activo ($service_mode)."
echo "Escritorio: $workspace_path"
echo "Descargas: $downloads_path"
echo "Raíz completa del equipo: $pc_root"
echo "Endpoint local: http://127.0.0.1:8787/mcp"
echo "Configuración: $config_directory"
