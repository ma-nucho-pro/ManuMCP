#!/usr/bin/env bash
set -Eeuo pipefail

config_directory="${MANUMCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/manumcp}"
if [[ "$(uname -s)" == "Darwin" ]]; then
    plist_path="$HOME/Library/LaunchAgents/com.manumcp.agent.plist"
    launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
    rm -f "$plist_path"
else
    systemctl --user disable --now manumcp.service >/dev/null 2>&1 || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/manumcp.service"
    if [[ -s "$config_directory/agent.pid" ]]; then
        old_pid="$(tr -dc '0-9' < "$config_directory/agent.pid" || true)"
        if [[ -n "$old_pid" ]]; then kill "$old_pid" >/dev/null 2>&1 || true; fi
    fi
fi
rm -f "$config_directory/agent.pid"
echo "Se retiró el arranque automático de ManuMCP. Se conservaron el token, la configuración y el repositorio."
