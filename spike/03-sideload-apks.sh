#!/usr/bin/env bash
# SC-1244 P1 · sideload de Instagram oficial + checker Play Integrity (SPIC).
# Instagram: apkeep (EFF, open source) proveedor apk-pure (espejo de binarios firmados de Play).
#   El proveedor google-play pidio credenciales -> NO se loguea ninguna cuenta (restriccion del spike;
#   el login es H2, bloqueado por cuenta). Fuente y version anotadas en README.md.
# SPIC: release oficial v1.4.0 de github.com/herzhenr/spic-android.
# Desechable.
set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${SCRATCH:-$SPIKE_DIR/work}
ADB=${ADB:-$SCRATCH/platform-tools/adb}
mkdir -p "$SCRATCH"

# adb oficial de Google (si no esta ya)
if [ ! -x "$ADB" ]; then
  curl -sSfL -o "$SCRATCH/platform-tools.zip" \
    https://dl.google.com/android/repository/platform-tools_r36.0.0-linux.zip
  (cd "$SCRATCH" && unzip -q -o platform-tools.zip)
fi
"$ADB" connect 127.0.0.1:5555

# SPIC (checker Integrity)
if [ ! -f "$SCRATCH/spic-v1.4.0.apk" ]; then
  curl -sSfL -o "$SCRATCH/spic-v1.4.0.apk" \
    https://github.com/herzhenr/spic-android/releases/download/v1.4.0/spic-v1.4.0.apk
fi
docker cp "$SCRATCH/spic-v1.4.0.apk" redroid:/data/local/tmp/spic.apk
docker exec redroid pm install -r -t /data/local/tmp/spic.apk

# Instagram oficial (xapk = base + splits) via apkeep
if [ ! -f "$SCRATCH/com.instagram.android.xapk" ]; then
  if [ ! -x "$SCRATCH/apkeep" ]; then
    curl -sSfL -o "$SCRATCH/apkeep" \
      https://github.com/EFForg/apkeep/releases/download/1.0.0/apkeep-x86_64-unknown-linux-gnu
    chmod +x "$SCRATCH/apkeep"
  fi
  "$SCRATCH/apkeep" -a com.instagram.android -d apk-pure "$SCRATCH"
fi
mkdir -p "$SCRATCH/ig"
(cd "$SCRATCH/ig" && unzip -o -q ../com.instagram.android.xapk)
# install-multiple: base + config.xxxhdpi (los splits del bundle de Play)
"$ADB" -s 127.0.0.1:5555 install-multiple \
  "$SCRATCH/ig/com.instagram.android.apk" "$SCRATCH/ig/config.xxxhdpi.apk"

echo "criterio 2: pm list packages | grep -c com.instagram.android = $(docker exec redroid pm list packages | grep -c com.instagram.android)"
