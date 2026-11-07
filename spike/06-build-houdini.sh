#!/usr/bin/env bash
# SC-1248 P1b · vía (b): imagen redroid con libhoudini en lugar de libndk_translation.
# Opción OFICIAL de redroid-script: -i / --install-houdini (argparse de redroid.py; el
# flag no sale en el README, pero es la vía documentada del proyecto; fuente:
# github.com/rote66/vendor_intel_proprietary_houdini, md5 verificado por el script, +
# redroid_libhoudini_hack que parchea ld.config). Para 13.0.0 el código lo soporta.
#
# HALLAZGO: el -i copia los binarios pero NO cambia el puente: la imagen base de redroid
# trae ro.dalvik.vm.native.bridge=libnb.so (-> libndk_translation). La tabla
# "Configuration" de remote-android/redroid-doc documenta que se pueden pisar props
# ro.* pasando el par clave=valor como argumento del contenedor (el propio README de
# redroid-script arranca así su imagen ndk). Por eso el docker run añade
# ro.dalvik.vm.native.bridge=libhoudini.so. Sin ese argumento sigue traduciendo ndk y
# Instagram SIGSEGA igual que en P1.
#
# Rollback: el contenedor ndk queda parado como redroid-ndk-rollback (NO borrado) y la
# imagen 13.0.0_mindthegapps intacta. Mismo volumen redroid-data.
set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${SCRATCH:-$SPIKE_DIR/work}
PIN=a4951b782fc8e06c845d9553bf07bb643fd8c158   # mismo pin que P1 (es el commit "houdini: update ...")
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

# -mtg = MindTheGapps (GMS, como P1) · -i = libhoudini
venv/bin/python redroid.py -a 13.0.0 -mtg -i

# parar el contenedor ndk SIN borrarlo (rollback) y liberar el nombre
docker stop redroid 2>/dev/null || true
docker rename redroid redroid-ndk-rollback 2>/dev/null || true

free -m | sed -n 2p   # requisito del spec: RAM libre antes de arrancar

docker run -d --name redroid \
  --privileged \
  --memory="$MEM" \
  -v /dev/binderfs:/dev/binderfs \
  -v redroid-data:/data \
  -p 127.0.0.1:5555:5555 \
  redroid/redroid:13.0.0_mindthegapps_houdini \
  ro.dalvik.vm.native.bridge=libhoudini.so

for i in $(seq 1 60); do
  [ "$(docker exec redroid getprop sys.boot_completed | tr -d '\r')" = "1" ] && break
  sleep 3
done
echo "boot=$(docker exec redroid getprop sys.boot_completed | tr -d '\r') bridge=$(docker exec redroid getprop ro.dalvik.vm.native.bridge)"
docker exec redroid ls /proc/sys/fs/binfmt_misc/ | grep -E 'arm' && echo "binfmt_misc: entradas houdini registradas"
echo "Instagram ya está instalada (volumen redroid-data compartido). Test: ./05-test-survival.sh houdini"
