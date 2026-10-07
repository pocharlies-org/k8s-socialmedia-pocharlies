#!/usr/bin/env bash
# SC-1244 P1 · arranque redroid base en docker (x86, nodo ubuntu). Desechable.
# Requisitos medidos 25-09: binder_linux cargado y /dev/binderfs montado (SC-1223).
# NO montar binderfs a mano aqui: es competencia de lo ya arreglado en SC-1223.
set -euo pipefail

IMG=${IMG:-redroid/redroid:13.0.0-latest}   # tag soportado por remote-android/redroid-doc
MEM=${MEM:-6g}                              # tope duro: el OOM del x86 lo provocan las sesiones Claude

ls /dev/binderfs/binder >/dev/null || { echo "FALTA /dev/binderfs (SC-1223) — no continuar"; exit 1; }
free -m

docker rm -f redroid 2>/dev/null || true
docker run -d --name redroid \
  --privileged \
  --memory="$MEM" \
  -v /dev/binderfs:/dev/binderfs \
  -v redroid-data:/data \
  -p 127.0.0.1:5555:5555 \
  "$IMG"

# Criterio 1
for i in $(seq 1 30); do
  [ "$(docker exec redroid getprop sys.boot_completed | tr -d '\r')" = "1" ] && break
  sleep 10
done
echo "criterio 1: sys.boot_completed=$(docker exec redroid getprop sys.boot_completed | tr -d '\r')"
free -m
