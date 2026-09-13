#!/usr/bin/env bash
set -Eeuo pipefail

config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
node_command="${MANUMCP_NODE:-}"
if [[ -z "$node_command" && -s "$config_directory/node-path.txt" ]]; then
    node_command="$(sed -n '1p' "$config_directory/node-path.txt")"
fi
node_command="${node_command:-$(command -v node || true)}"
tunnel_config="$config_directory/tunnel.json"
if [[ -z "$node_command" || ! -x "$node_command" || ! -s "$tunnel_config" ]]; then
    echo "No existe la configuración automática del túnel de ManuMCP." >&2
    exit 1
fi

read_tunnel_value() {
    "$node_command" -e 'const fs = require("node:fs"); const [file, key] = process.argv.slice(1); const value = JSON.parse(fs.readFileSync(file, "utf8"))[key]; if (typeof value !== "string" || value.length === 0) process.exit(1); process.stdout.write(value);' "$tunnel_config" "$1"
}

tunnel_id="$(read_tunnel_value tunnelId)"
profile="$(read_tunnel_value profile)"
client_path="$(read_tunnel_value clientPath)"
project_root="$(read_tunnel_value projectRoot)"
if [[ "$(uname -s)" == "Darwin" ]]; then
    control_plane_key="$(security find-generic-password -a "$USER" -s "com.manumcp.tunnel" -w)"
else
    key_path="$config_directory/control-plane-key"
    if [[ ! -s "$key_path" ]]; then
        echo "No existe la credencial protegida del túnel: $key_path" >&2
        exit 1
    fi
    control_plane_key="$(sed -n '1p' "$key_path")"
fi
if [[ -z "$control_plane_key" ]]; then
    echo "La credencial del túnel está vacía." >&2
    exit 1
fi

export CONTROL_PLANE_API_KEY="$control_plane_key"
export MANUMCP_CONFIG_DIR="$config_directory"
export MANUMCP_TUNNEL_PROFILE="$profile"
export MANUMCP_TUNNEL_CLIENT="$client_path"
unset control_plane_key
exec bash "$project_root/scripts/start-tunnel-unix.sh" "$tunnel_id"
