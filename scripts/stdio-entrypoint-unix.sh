#!/usr/bin/env bash
set -Eeuo pipefail

config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
project_path_file="$config_directory/project-root.txt"
roots_path="$config_directory/roots.json"
node_command="${MANUMCP_NODE:-}"
if [[ -z "$node_command" && -s "$config_directory/node-path.txt" ]]; then
    node_command="$(sed -n '1p' "$config_directory/node-path.txt")"
fi
node_command="${node_command:-$(command -v node || true)}"
if [[ -z "$node_command" || ! -x "$node_command" || ! -s "$project_path_file" || ! -s "$roots_path" ]]; then
    echo "No existe una instalación válida de ManuMCP. Ejecuta scripts/install-unix.sh." >&2
    exit 1
fi

project_root="$(sed -n '1p' "$project_path_file")"
read_root() {
    "$node_command" -e 'const fs = require("node:fs"); const [file, key] = process.argv.slice(1); const value = JSON.parse(fs.readFileSync(file, "utf8"))[key]; if (typeof value !== "string" || value.length === 0) process.exit(1); process.stdout.write(value);' "$roots_path" "$1"
}
export MANUMCP_WORKSPACE="${MANUMCP_WORKSPACE:-$(read_root workspace)}"
export MANUMCP_DOWNLOADS="${MANUMCP_DOWNLOADS:-$(read_root downloads)}"
export MANUMCP_PC_ROOT="${MANUMCP_PC_ROOT:-$(read_root pcRoot)}"
export MANUMCP_PROFILE="${MANUMCP_PROFILE:-edit_safe}"

cd "$project_root"
exec "$node_command" "$project_root/dist/app/server.js" --stdio
