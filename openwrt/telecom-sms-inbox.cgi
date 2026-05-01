#!/bin/sh
set -eu

CONFIG="${TELECOM_SMS_CONFIG:-/etc/telecom-monthly-claim.env}"
[ -r "$CONFIG" ] && . "$CONFIG"

SMS_INBOX_TOKEN="${SMS_INBOX_TOKEN:-}"
SMS_INBOX_FILE="${SMS_INBOX_FILE:-/tmp/telecom-sms-inbox.jsonl}"
MODE="${1:-messages}"

query_value() {
  key="$1"
  printf '%s' "${QUERY_STRING:-}" | tr '&' '\n' | sed -n "s/^${key}=//p" | head -n 1
}

json_escape() {
  awk 'BEGIN { ORS="" } {
    gsub(/\\/,"\\\\");
    gsub(/"/,"\\\"");
    gsub(/\r/,"\\r");
    gsub(/\t/,"\\t");
    if (NR > 1) printf "\\n";
    printf "%s", $0;
  }'
}

reply_json() {
  status="$1"
  body="$2"
  [ "$status" = "200" ] || printf 'Status: %s\r\n' "$status"
  printf 'Content-Type: application/json; charset=utf-8\r\n\r\n'
  printf '%s\n' "$body"
}

authorized() {
  [ -z "$SMS_INBOX_TOKEN" ] && return 0
  [ "${HTTP_AUTHORIZATION:-}" = "Bearer $SMS_INBOX_TOKEN" ] && return 0
  [ "$(query_value token)" = "$SMS_INBOX_TOKEN" ] && return 0
  return 1
}

extract_sender() {
  sed -n \
    -e 's/.*"sender"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    -e 's/.*"from"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    -e 's/.*"address"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

if ! authorized; then
  reply_json "401 Unauthorized" '{"ok":false,"error":"unauthorized"}'
  exit 0
fi

case "$MODE" in
  health)
    reply_json "200" '{"ok":true}'
    ;;

  sms)
    if [ "${REQUEST_METHOD:-GET}" != "POST" ]; then
      reply_json "405 Method Not Allowed" '{"ok":false,"error":"method not allowed"}'
      exit 0
    fi
    len="${CONTENT_LENGTH:-0}"
    body="$(dd bs=1 count="$len" 2>/dev/null || true)"
    compact_body="$(printf '%s' "$body" | tr '\r\n' '  ')"
    sender="$(printf '%s' "$compact_body" | extract_sender || true)"
    [ -n "$sender" ] || sender="10001"
    ts="$(date +%s)000"
    id="${ts}-$$"
    mkdir -p "$(dirname "$SMS_INBOX_FILE")"
    printf '{"id":"%s","sender":"%s","text":"%s","receivedAt":%s}\n' \
      "$(printf '%s' "$id" | json_escape)" \
      "$(printf '%s' "$sender" | json_escape)" \
      "$(printf '%s' "$compact_body" | json_escape)" \
      "$ts" >> "$SMS_INBOX_FILE"
    chmod 600 "$SMS_INBOX_FILE" 2>/dev/null || true
    reply_json "200" "{\"ok\":true,\"id\":\"$(printf '%s' "$id" | json_escape)\"}"
    ;;

  messages)
    since="$(query_value since)"
    limit="$(query_value limit)"
    case "$since" in ''|*[!0-9]*) since=0 ;; esac
    case "$limit" in ''|*[!0-9]*) limit=30 ;; esac
    if [ ! -f "$SMS_INBOX_FILE" ]; then
      reply_json "200" '{"ok":true,"messages":[]}'
      exit 0
    fi
    awk -v since="$since" -v limit="$limit" '
      {
        ts=$0;
        sub(/^.*"receivedAt":/, "", ts);
        sub(/[^0-9].*$/, "", ts);
        if ((ts + 0) >= since) {
          items[++n] = $0;
        }
      }
      END {
        start = n - limit + 1;
        if (start < 1) start = 1;
        printf "Content-Type: application/json; charset=utf-8\r\n\r\n";
        printf "{\"ok\":true,\"messages\":[";
        sep = "";
        for (i = start; i <= n; i++) {
          printf "%s%s", sep, items[i];
          sep = ",";
        }
        printf "]}\n";
      }
    ' "$SMS_INBOX_FILE"
    ;;

  *)
    reply_json "404 Not Found" '{"ok":false,"error":"not found"}'
    ;;
esac
