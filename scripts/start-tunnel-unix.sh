#!/usr/bin/env bash
set -Eeuo pipefail

tunnel_id="${1:-${MANUMCP_TUNNEL_ID:-}}"
profile="${MANUMCP_TUNNEL_PROFILE:-manumcp-local}"
client_path="${MANUMCP_TUNNEL_CLIENT:-tunnel-client}"
if [[ -z "$tunnel_id" || ! "$tunnel_id" =~ ^tunnel_[[:xdigit:]]{32}$ ]]; then
    echo "Uso: MANUMCP_TUNNEL_ID=tunnel_<32 hex> CONTROL_PLANE_API_KEY=... bash scripts/start-tunnel-unix.sh" >&2
    exit 1
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
    echo "Define CONTROL_PLANE_API_KEY solo en esta sesión; no lo guardes en el repositorio." >&2
    exit 1
fi

script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
stdio_wrapper="$project_root/scripts/stdio-entrypoint-unix.sh"
if [[ ! -f "$stdio_wrapper" ]]; then
    echo "No existe el transporte stdio de ManuMCP: $stdio_wrapper" >&2
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

"$client_path" init --sample sample_mcp_stdio_local --profile "$profile" --tunnel-id "$tunnel_id" --mcp-command "$stdio_wrapper"
"$client_path" doctor --profile "$profile" --explain
echo "ManuMCP quedó preparado para el túnel '$tunnel_id'."
echo "Mantén este proceso activo para que ChatGPT pueda descubrir y llamar las herramientas."
exec "$client_path" run --profile "$profile"
