#!/usr/bin/env bash
# Print the LAN URL for opening the running dev site on a phone.
#
# The Vite dev server binds to all interfaces (`server.host: "::"` in
# apps/web/vite.config.ts) and proxies /api, /ws, /storage … to the backend, so
# a phone on the same Wi-Fi can use the app end-to-end without any extra setup.
#
# Two things it checks, because both fail *silently* on a phone:
#   • the WebSocket origin allowlist — without the phone's origin the app loads,
#     the REST API works, and realtime never connects (no messages, no typing);
#   • whether the machine is reachable over the LAN at all.
#
# Usage:
#   make mobile          # print the URL, probe, warn
#   FIX=1 make mobile    # also repair ALLOWED_ORIGINS in .dev.env and restart
#                        # the backend window (nothing is restarted otherwise)
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

# shellcheck source=scripts/lan-origins.sh
. "$(dirname "$0")/lan-origins.sh"

PORT="${WEB_PORT:-8081}"
MOBILE_WEB_PORT="${MOBILE_WEB_PORT:-8443}"
FIX="${FIX:-0}"

ip="$(gomo6_lan_ip)"
if [ -z "$ip" ]; then
  echo "✗ Не удалось определить LAN-IP. Телефон должен быть в той же Wi-Fi сети." >&2
  exit 1
fi

mdns="$(gomo6_mdns_name)"
url="http://${ip}:${PORT}"

echo "Открой на телефоне (та же Wi-Fi сеть):"
echo
echo "    ${url}"
[ -n "$mdns" ] && echo "    http://${mdns}:${PORT}   (тот же Mac по Bonjour, адрес не меняется)"
echo

# ── Reachability probe ──────────────────────────────────────────────────────
probe() {
  local path="$1" label="$2"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "${url}${path}" || echo 000)"
    if [ "$code" = "200" ]; then
      printf '  \033[0;32m✔\033[0m %-10s %s\n' "$label" "$code"
    else
      printf '  \033[1;33m⚠\033[0m %-10s %s\n' "$label" "$code"
    fi
  fi
}

echo "Проверка доступности:"
probe "/" "web"
probe "/api/v1/feed?limit=1" "api"

# ── WebSocket origin probe ──────────────────────────────────────────────────
# The hub validates the Origin header (internal/websocket/hub.go). A phone sends
# its own origin, which is not `http://localhost:8081` — this is the probe for
# the exact thing that breaks realtime, through the same Vite proxy the phone
# uses. 101 = accepted, 403 = the origin is not in ALLOWED_ORIGINS.
probe_ws() {
  command -v curl >/dev/null 2>&1 || return 0
  local key code
  key="$(openssl rand -base64 16)"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: ${key}" \
    -H "Origin: ${url}" "${url}/ws" || echo 000)"
  if [ "$code" = "101" ]; then
    printf '  \033[0;32m✔\033[0m %-10s %s\n' "realtime" "$code"
    return 0
  fi
  printf '  \033[1;31m✗\033[0m %-10s %s (origin телефона не разрешён)\n' "realtime" "$code"
  return 1
}
ws_ok=1
probe_ws || ws_ok=0

# ── Repair the allowlist ────────────────────────────────────────────────────
wanted="$(gomo6_allowed_origins "$PORT" "$MOBILE_WEB_PORT")"
if [ "$ws_ok" = 0 ] && [ -f .dev.env ]; then
  echo
  if ! grep -q "https://${ip}:${MOBILE_WEB_PORT}" .dev.env 2>/dev/null; then
    if [ "$FIX" = "1" ]; then
      # Only the dev-override line: the other ALLOWED_ORIGINS in .dev.env comes
      # from the root .env (docs./dev. hosts) and is not ours to rewrite. The
      # dev block is the one that mentions :3001 (docs) and :3002 (dashboard).
      tmp="$(mktemp)"
      sed "/localhost:3001/ s|^export ALLOWED_ORIGINS=.*|export ALLOWED_ORIGINS='${wanted}'|" .dev.env > "$tmp"
      mv "$tmp" .dev.env
      chmod 600 .dev.env
      printf '  %b\n' "\033[0;32m✔\033[0m .dev.env: ALLOWED_ORIGINS обновлён"
      if tmux has-session -t gomo6-dev 2>/dev/null; then
        tmux respawn-window -k -t gomo6-dev:backend >/dev/null 2>&1 \
          && printf '  %b\n' "\033[0;32m✔\033[0m backend перезапущен" \
          || printf '  %b\n' "\033[1;33m⚠\033[0m не удалось перезапустить окно backend — сделай это вручную"
      else
        printf '  %b\n' "\033[1;33m⚠\033[0m tmux-сессия gomo6-dev не найдена — перезапусти бэкенд сам"
      fi
    else
      echo "  Realtime с телефона не подключится: в .dev.env нет origin'ов телефона."
      echo "  Починить (обновит .dev.env и перезапустит окно backend):"
      echo
      echo "      FIX=1 make mobile"
      echo
      echo "  Вручную: make dev (перезапишет .dev.env), затем"
      echo "      tmux respawn-window -k -t gomo6-dev:backend"
    fi
  fi
fi

# ── Что важно знать ─────────────────────────────────────────────────────────
echo
echo "Подсказки:"
echo "  • Оверлей счётчиков скролла (проверка плавности чата): ${url}/messages?scrolldebug=1"
echo "  • Дев-логин: demo / gomo6-demo-9f3k2x (и alice / bob с тем же паролем)."
echo "    Паролем, а не passkey: WEBAUTHN_RP_ID=localhost, с телефона passkey не сработает."
echo "  • HTTP-режим = не secure context: «Заметки» (WebCrypto), установка PWA и push"
echo "    на телефоне работать не будут — они требуют https."
echo "  • Если не открывается — Mac и телефон в одной Wi-Fi сети, и macOS спросит"
echo "    про входящие соединения для node: разреши."
