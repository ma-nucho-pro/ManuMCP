#!/usr/bin/env bash
set -Eeuo pipefail

repository_url="${MANUMCP_REPOSITORY_URL:-https://github.com/ma-nucho-pro/ManuMCP.git}"
install_directory="${MANUMCP_INSTALL_DIR:-$HOME/ManuMCP}"
clients="${MANUMCP_CLIENTS:-auto}"
if [[ ! -e "$install_directory" ]]; then
    git clone --depth 1 "$repository_url" "$install_directory"
elif [[ ! -d "$install_directory/.git" ]]; then
    echo "La ruta $install_directory ya existe y no es un repositorio Git; no se sobrescribirá." >&2
    exit 1
fi
cd "$install_directory"
bash scripts/install-unix.sh
node_args=(scripts/configure-clients.mjs --client "$clients")
if [[ "${MANUMCP_OPEN_CHATGPT:-0}" == "1" ]]; then
    node_args+=(--open-chatgpt)
fi
node_command="${MANUMCP_NODE:-$(command -v node || true)}"
if [[ -z "$node_command" || ! -x "$node_command" ]]; then
    echo "No se encontró Node.js para configurar los clientes MCP después de instalar ManuMCP." >&2
    exit 1
fi
exec "$node_command" "${node_args[@]}"
