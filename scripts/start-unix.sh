#!/usr/bin/env bash
set -Eeuo pipefail

config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
project_path_file="$config_directory/project-root.txt"
roots_path="$config_directory/roots.json"
if [[ ! -s "$project_path_file" || ! -s "$roots_path" ]]; then
    echo "No existe la instalación local de ManuMCP en $config_directory. Ejecuta scripts/install-unix.sh." >&2
    exit 1
fi

project_root="$(sed -n '1p' "$project_path_file")"
node_command="${MANUMCP_NODE:-}"
if [[ -z "$node_command" && -s "$config_directory/node-path.txt" ]]; then
    node_command="$(sed -n '1p' "$config_directory/node-path.txt")"
fi
node_command="${node_command:-$(command -v node || true)}"
if [[ -z "$node_command" || ! -x "$node_command" ]]; then
    echo "No se encontró Node.js para iniciar ManuMCP." >&2
    exit 1
fi
entry_point="$project_root/dist/app/server.js"
if [[ ! -f "$entry_point" ]]; then
    echo "No existe $entry_point. Ejecuta scripts/install-unix.sh." >&2
    exit 1
fi

read_root() {
    "$node_command" -e 'const fs = require("node:fs"); const [file, key] = process.argv.slice(1); const value = JSON.parse(fs.readFileSync(file, "utf8"))[key]; if (typeof value !== "string" || value.length === 0) process.exit(1); process.stdout.write(value);' "$roots_path" "$1"
}

export MANUMCP_WORKSPACE="${MANUMCP_WORKSPACE:-$(read_root workspace)}"
export MANUMCP_DOWNLOADS="${MANUMCP_DOWNLOADS:-$(read_root downloads)}"
export MANUMCP_PC_ROOT="${MANUMCP_PC_ROOT:-$(read_root pcRoot)}"
export MANUMCP_LOCAL_TOKEN_FILE="${MANUMCP_LOCAL_TOKEN_FILE:-$config_directory/local-token.txt}"
export MANUMCP_CONFIG_DIR="$config_directory"
export MANUMCP_PORT="${MANUMCP_PORT:-8787}"
export MANUMCP_PROFILE="${MANUMCP_PROFILE:-edit_safe}"

cd "$project_root"
exec "$node_command" "$entry_point" "$@"
