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
mdns_url=""
[ -n "$mdns" ] && mdns_url="http://${mdns}:${PORT}"

echo "Открой на телефоне (та же Wi-Fi сеть):"
echo
echo "    ${url}"
[ -n "$mdns_url" ] && echo "    ${mdns_url}   (тот же Mac по Bonjour — адрес не меняется при смене IP)"
echo

# ── Probes ──────────────────────────────────────────────────────────────────
# Every URL that is printed above is probed here, the way the phone will ask for
# it — an address this script prints must never be one the dev server refuses.
command -v curl >/dev/null 2>&1 || exit 0
command -v openssl >/dev/null 2>&1 || true

# curl's `-w` prints "000" itself when it cannot connect, so the exit status must
# NOT be turned into another "000" on stdout — that is how a working probe ends up
# reported as "000000".
http_code() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$@" 2>/dev/null)" || true
  printf '%s' "${code:-000}"
}

# 101 = the WebSocket upgrade was accepted, 403 = the origin is not in
# ALLOWED_ORIGINS, 000 = the backend is unreachable (it is usually still booting
# after a restart — that, not the origin list, is what `api 500` next to it means).
ws_status() {
  local origin="$1" key code
  key="$(openssl rand -base64 16 2>/dev/null || echo 'AAAAAAAAAAAAAAAAAAAAAA==')"
  # A successful upgrade makes curl exit non-zero (the "transfer" never ends) —
  # the status code, not the exit code, is the answer.
  code="$(http_code \
    -H "Connection: Upgrade" -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: ${key}" \
    -H "Origin: ${origin}" "${origin}/ws")"
  printf '%s' "$code"
}

web_status() { # <url> — 200, or the Vite host-check 403, or 000
  local target="$1" code
  code="$(http_code "${target}/")"
  printf '%s' "$code"
}

is_host_blocked() { # <url> — Vite said "this host is not allowed"
  curl -s --max-time 4 "$1" 2>/dev/null | grep -q "is not allowed" && return 0
  return 1
}

api_code="$(http_code "${url}/api/v1/feed?limit=1")"
ws_code="$(ws_status "$url")"

echo "Проверка (с этой машины, тем же путём, что и телефон):"
printf '  %-38s web %-4s api %-4s realtime %s\n' "$url" "$(web_status "$url")" "$api_code" "$ws_code"

host_blocked=0
if [ -n "$mdns_url" ]; then
  mdns_web="$(web_status "$mdns_url")"
  printf '  %-38s web %-4s\n' "$mdns_url" "$mdns_web"
  if [ "$mdns_web" = "403" ] && is_host_blocked "$mdns_url"; then
    host_blocked=1
  fi
fi

# ── Repair the allowlist ────────────────────────────────────────────────────
wanted="$(gomo6_allowed_origins "$PORT" "$MOBILE_WEB_PORT")"
if [ "$ws_code" = "403" ] && [ -f .dev.env ]; then
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
