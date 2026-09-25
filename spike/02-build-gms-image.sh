#!/usr/bin/env bash
# SC-1244 P1 · GMS por la via estandar open source: redroid-script (MindTheGapps)
# construye una imagen nueva FROM redroid/redroid:13.0.0-latest sin recompilar AOSP.
# Fuentes: github.com/ayasa520/redroid-script (commit a4951b7) y
#          github.com/s1204IT/MindTheGappsBuilder (zip 13.0.0-x86_64-20240226, md5 verificado por el script).
# Desechable.
set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${SCRATCH:-$SPIKE_DIR/work}
PIN=a4951b782fc8e06c845d9553bf07bb643fd8c158
MEM=${MEM:-6g}
mkdir -p "$SCRATCH"

if [ ! -d "$SCRATCH/redroid-script" ]; then
  git clone https://github.com/ayasa520/redroid-script.git "$SCRATCH/redroid-script"
fi
git -C "$SCRATCH/redroid-script" fetch -q origin
git -C "$SCRATCH/redroid-script" checkout -q "$PIN"

cd "$SCRATCH/redroid-script"
python3 -m venv venv
venv/bin/pip install -q -r requirements.txt

# Descarga MindTheGapps (md5 verificado), escribe Dockerfile (FROM redroid/redroid:13.0.0-latest +
# COPY mindthegapps / + ENTRYPOINT con setupwizard deshabilitado) y hace docker build.
venv/bin/python redroid.py -a 13.0.0 -mtg

# Recrear el contenedor con la imagen con GMS, sobre el MISMO volumen /data
docker rm -f redroid 2>/dev/null || true
docker run -d --name redroid \
  --privileged \
  --memory="$MEM" \
  -v /dev/binderfs:/dev/binderfs \
  -v redroid-data:/data \
  -p 127.0.0.1:5555:5555 \
  redroid/redroid:13.0.0_mindthegapps

for i in $(seq 1 30); do
  [ "$(docker exec redroid getprop sys.boot_completed | tr -d '\r')" = "1" ] && break
  sleep 10
done
echo "boot_completed=$(docker exec redroid getprop sys.boot_completed | tr -d '\r')"
echo "GMS: $(docker exec redroid pm list packages | grep -c -E 'com.google.android.gms$|com.android.vending$') (esperado 2)"
