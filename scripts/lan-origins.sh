#!/usr/bin/env bash
# =============================================================================
# LAN origins for the local dev stack — sourced, not executed.
# =============================================================================
# `scripts/dev.sh` uses this to write ALLOWED_ORIGINS into .dev.env, and
# `scripts/mobile-url.sh` uses it to check (or repair) the same value. Kept in
# one place because it has to match what the *backend* sees: the WebSocket hub
# validates the Origin header of every connection against this list
# (`apps/backend-go/internal/websocket/hub.go`, `CheckOrigin`), and Vite proxies
# the phone's WebSocket through unchanged.
#
# Why it matters: a phone that opens the dev site over the LAN has an origin the
# list did not know (`http://192.168.x.y:8081`, `https://<name>.local:8443`). The
# app loads and the REST API works, so it *looks* fine — but realtime silently
# never connects: no new messages, no typing, no presence. That is the bug this
# file exists to prevent.

# The first active interface with an IPv4 address (macOS, then Linux).
gomo6_lan_ip() {
    local ip=""
    if command -v ipconfig >/dev/null 2>&1; then
        local iface
        for iface in en0 en1 en2 bridge0; do
            ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
            [ -n "$ip" ] && break
        done
    fi
    if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
        ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^$|^127\.' | head -1 || true)"
    fi
    printf '%s' "$ip"
}

# The Mac's Bonjour name (`<name>.local`) — stable across DHCP lease changes, so
# it is the URL to bookmark on the phone.
gomo6_mdns_name() {
    local name=""
    if command -v scutil >/dev/null 2>&1; then
        name="$(scutil --get LocalHostName 2>/dev/null || true)"
    fi
    [ -n "$name" ] && printf '%s.local' "$name"
}

# gomo6_allowed_origins [web-port] [tls-port]
gomo6_allowed_origins() {
    local web_port="${1:-8081}"
    local tls_port="${2:-8443}"
    local origins="http://localhost:${web_port},http://localhost:3001,http://localhost:3002"
    local ip mdns
    ip="$(gomo6_lan_ip)"
    mdns="$(gomo6_mdns_name)"

    if [ -n "$ip" ]; then
        origins="${origins},http://${ip}:${web_port},https://${ip}:${tls_port}"
    fi
    if [ -n "$mdns" ]; then
        origins="${origins},http://${mdns}:${web_port},https://${mdns}:${tls_port}"
    fi

    printf '%s' "$origins"
}
