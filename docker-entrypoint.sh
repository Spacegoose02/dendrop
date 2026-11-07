#!/bin/sh
# Started as root (the default), make /data belong to PUID:PGID (Unraid's nobody:users,
# 99:100, unless set otherwise); the server then drops to that user
# (packages/server/src/privileges.ts). Started with --user, nothing to do.
set -e
DATA_DIR="${DENDROP_DATA_DIR:-/data}"

# DENDROP_HTTPS=self-signed with no certificate of your own: make one the first time, for
# https:// on the home network without a reverse proxy (packages/server/src/config.ts reads it).
if [ "$(echo "${DENDROP_HTTPS:-}" | tr 'A-Z' 'a-z')" = "self-signed" ] && [ -z "${DENDROP_TLS_CERT:-}" ]; then
  TLS_DIR="$DATA_DIR/tls"
  if [ ! -s "$TLS_DIR/self-signed.crt" ] || [ ! -s "$TLS_DIR/self-signed.key" ]; then
    mkdir -p "$TLS_DIR"
    SAN="DNS:localhost,IP:127.0.0.1"
    HOST="$(echo "${DENDROP_PUBLIC_URL:-}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
    if [ -n "$HOST" ] && [ "$HOST" != "localhost" ]; then
      if echo "$HOST" | grep -Eq '^[0-9.]+$'; then SAN="$SAN,IP:$HOST"; else SAN="$SAN,DNS:$HOST"; fi
    fi
    echo "Making a self-signed HTTPS certificate in $TLS_DIR ($SAN)"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
      -subj "/CN=${HOST:-dendrop}" -addext "subjectAltName=$SAN" \
      -keyout "$TLS_DIR/self-signed.key" -out "$TLS_DIR/self-signed.crt" 2>/dev/null
    chmod 600 "$TLS_DIR/self-signed.key"
  fi
fi

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-99}"
  PGID="${PGID:-100}"
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ]; then
    echo "Setting owner of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  elif [ -d "$DATA_DIR/tls" ]; then
    chown -R "$PUID:$PGID" "$DATA_DIR/tls"
  fi
fi
exec "$@"
