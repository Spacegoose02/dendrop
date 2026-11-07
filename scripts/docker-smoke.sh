#!/bin/sh
# Starts a built image the way Unraid does (as root, and with --user 99:100) and fails
# unless the server answers /api/health, then once more with built-in self-signed HTTPS.
# Usage: scripts/docker-smoke.sh IMAGE
set -eu
image="$1"
work="$(mktemp -d)"
trap 'docker rm -f dd-smoke >/dev/null 2>&1 || true; sudo rm -rf "$work" 2>/dev/null || rm -rf "$work"' EXIT

check() {
  name="$1"
  scheme="$2"
  shift 2
  docker run -d --name dd-smoke -p 18080:8080 -v "$work/$name:/data" "$@" "$image" >/dev/null
  for _ in $(seq 1 30); do
    if curl -skf "$scheme://127.0.0.1:18080/api/health" 2>/dev/null | grep -q '"ok"'; then
      echo "ok: $name"
      docker rm -f dd-smoke >/dev/null
      return 0
    fi
    sleep 2
  done
  echo "The image didn't start ($name):"
  docker logs dd-smoke || true
  exit 1
}

mkdir -p "$work/root"
check root http
mkdir -p "$work/user"
sudo chown -R 99:100 "$work/user" 2>/dev/null || chmod -R 777 "$work/user"
check user http --user 99:100
mkdir -p "$work/https"
check https https -e DENDROP_HTTPS=self-signed
