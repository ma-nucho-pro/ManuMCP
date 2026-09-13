#!/usr/bin/env bash
set -Eeuo pipefail

cleanup() {
    unset CONTROL_PLANE_API_KEY
}
trap cleanup EXIT

tunnel_id="${1:-${MANUMCP_TUNNEL_ID:-}}"
profile="${MANUMCP_TUNNEL_PROFILE:-manumcp-local}"
client_path="${MANUMCP_TUNNEL_CLIENT:-tunnel-client}"
if [[ -z "$tunnel_id" || ! "$tunnel_id" =~ ^tunnel_[[:xdigit:]]{32}$ ]]; then
    echo "Uso: CONTROL_PLANE_API_KEY=... bash scripts/install-tunnel-unix.sh tunnel_<32 hex>" >&2
    exit 1
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
    echo "Define CONTROL_PLANE_API_KEY solo en esta sesión; no se guarda en el repositorio." >&2
    exit 1
fi

script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
log_directory="$config_directory/logs"
mkdir -p "$config_directory" "$log_directory"
chmod 700 "$config_directory" "$log_directory"

if [[ ! -s "$config_directory/project-root.txt" || ! -s "$config_directory/roots.json" ]]; then
    echo "Instala primero el agente con scripts/install-unix.sh." >&2
    exit 1
fi

if [[ "$client_path" == */* ]]; then
    if [[ ! -x "$client_path" ]]; then
        echo "No se encontró tunnel-client ejecutable en $client_path." >&2
        exit 1
    fi
else
    client_path="$(command -v "$client_path" || true)"
    if [[ -z "$client_path" ]]; then
        echo "No se encontró tunnel-client en PATH." >&2
        exit 1
    fi
fi

stdio_wrapper="$project_root/scripts/stdio-entrypoint-unix.sh"
"$client_path" init --sample sample_mcp_stdio_local --profile "$profile" --tunnel-id "$tunnel_id" --mcp-command "$stdio_wrapper"
"$client_path" doctor --profile "$profile" --explain

if [[ "$(uname -s)" == "Darwin" ]]; then
    security add-generic-password -U -a "$USER" -s "com.manumcp.tunnel" -w "$CONTROL_PLANE_API_KEY" >/dev/null
else
    key_path="$config_directory/control-plane-key"
    umask 077
    printf '%s\n' "$CONTROL_PLANE_API_KEY" > "$key_path"
    chmod 600 "$key_path"
fi

node_command="${MANUMCP_NODE:-}"
if [[ -z "$node_command" && -s "$config_directory/node-path.txt" ]]; then
    node_command="$(sed -n '1p' "$config_directory/node-path.txt")"
fi
node_command="${node_command:-$(command -v node || true)}"
if [[ -z "$node_command" || ! -x "$node_command" ]]; then
    echo "No se encontró Node.js para guardar la configuración del túnel." >&2
    exit 1
fi
tunnel_config="$config_directory/tunnel.json"
"$node_command" -e 'const fs = require("node:fs"); const [file, tunnelId, profileValue, client, root] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ tunnelId, profile: profileValue, clientPath: client, projectRoot: root }) + "\n", { mode: 0o600 });' "$tunnel_config" "$tunnel_id" "$profile" "$client_path" "$project_root"
chmod 600 "$tunnel_config"

daemon_script="$project_root/scripts/start-tunnel-unix-daemon.sh"
service_mode=""
if [[ "$(uname -s)" == "Darwin" ]]; then
    launch_agents="$HOME/Library/LaunchAgents"
    mkdir -p "$launch_agents"
    plist_path="$launch_agents/com.manumcp.tunnel.plist"
    "$node_command" -e 'const fs = require("node:fs"); const [file, shell, script, root, config, out, err] = process.argv.slice(1); const esc = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const item = value => "<string>" + esc(value) + "</string>"; const xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.manumcp.tunnel</string>\n<key>ProgramArguments</key><array>" + item(shell) + item(script) + "</array>\n<key>WorkingDirectory</key>" + item(root) + "\n<key>EnvironmentVariables</key><dict><key>MANUMCP_CONFIG_DIR</key>" + item(config) + "</dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key>" + item(out) + "\n<key>StandardErrorPath</key>" + item(err) + "\n</dict></plist>\n"; fs.writeFileSync(file, xml, { mode: 0o600 });' "$plist_path" "/bin/bash" "$daemon_script" "$project_root" "$config_directory" "$log_directory/tunnel.log" "$log_directory/tunnel-error.log"
    launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist_path"
    launchctl kickstart -k "gui/$(id -u)/com.manumcp.tunnel"
    service_mode="launchd"
else
    systemd_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    service_path="$systemd_directory/manumcp-tunnel.service"
    mkdir -p "$systemd_directory"
    {
        printf '%s\n' '[Unit]' 'Description=ManuMCP secure MCP tunnel' 'After=network-online.target' '' '[Service]' 'Type=simple'
        printf 'WorkingDirectory="%s"\n' "$project_root"
        printf 'ExecStart=/bin/bash "%s"\n' "$daemon_script"
        printf 'Environment="MANUMCP_CONFIG_DIR=%s"\n' "$config_directory"
        printf '%s\n' 'Restart=on-failure' 'RestartSec=5' '' '[Install]' 'WantedBy=default.target'
    } > "$service_path"
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now manumcp-tunnel.service >/dev/null 2>&1; then
        service_mode="systemd-user"
    else
        nohup /bin/bash "$daemon_script" >> "$log_directory/tunnel.log" 2>> "$log_directory/tunnel-error.log" < /dev/null &
        printf '%s\n' "$!" > "$config_directory/tunnel.pid"
        chmod 600 "$config_directory/tunnel.pid"
        service_mode="background"
    fi
fi

echo "El túnel de ManuMCP quedó instalado con arranque automático ($service_mode)."
echo "Túnel: $tunnel_id"
echo "Perfil: $profile"
echo "La clave quedó protegida en el llavero del usuario (macOS) o en un archivo 600 (Linux)."
