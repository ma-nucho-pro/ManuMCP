#!/usr/bin/env bash
set -Eeuo pipefail

repository_url="${MANUMCP_REPOSITORY_URL:-https://github.com/ma-nucho-pro/ManuMCP.git}"
install_directory="${MANUMCP_INSTALL_DIR:-$HOME/ManuMCP}"
if [[ ! -e "$install_directory" ]]; then
    git clone --depth 1 "$repository_url" "$install_directory"
elif [[ ! -d "$install_directory/.git" ]]; then
    echo "La ruta $install_directory ya existe y no es un repositorio Git; no se sobrescribirá." >&2
    exit 1
fi
cd "$install_directory"
exec bash scripts/install-unix.sh
