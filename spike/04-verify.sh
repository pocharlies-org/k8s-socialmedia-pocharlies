#!/usr/bin/env bash
# SC-1244 P1 · comandos literales de verificacion de los criterios 1, 2 y 4 del 00-spec.md.
# Imprime cada comando y su salida para pegarlos en 50-entrega.md. Desechable.
set -uo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${SCRATCH:-$SPIKE_DIR/work}
ADB=${ADB:-$SCRATCH/platform-tools/adb}

echo "### Criterio 1 (redroid arranca con binder)"
echo "\$ docker exec redroid getprop sys.boot_completed"
docker exec redroid getprop sys.boot_completed

echo
echo "### Criterio 2 (GMS + Instagram instalados)"
echo "\$ docker exec redroid pm list packages | grep -c com.instagram.android"
docker exec redroid pm list packages | grep -c com.instagram.android
echo "\$ docker exec redroid pm list packages | grep -cE 'com.google.android.gms\$|com.android.vending\$'"
docker exec redroid pm list packages | grep -cE 'com.google.android.gms$|com.android.vending$'

echo
echo "### Criterio 4 (Play Integrity)"
echo "El veredicto es visual: se lanza SPIC (com.henrikherzig.playintegritychecker), se pulsa"
echo "'Make Play Integrity Request' y se captura la pantalla. Medido 25-09: NO_INTEGRITY"
echo "(ningun nivel), App/Account UNEVALUATED. Ver adjuntos en SC-1211:"
echo "  integrity-playcheck.png  y  boot-redroid-home.png"
echo "Verificacion del adjunto:"
echo "\$ python3 ~/.local/libexec/x86-host-runtime/jira_rest.py attachments SC-1211 | grep -ic integrity"
python3 ~/.local/libexec/x86-host-runtime/jira_rest.py attachments SC-1211 | grep -ic integrity

echo
echo "### Lanzar SPIC y capturar (manual, para reproducir el PNG)"
echo "\$ $ADB -s 127.0.0.1:5555 shell am start -n com.henrikherzig.playintegritychecker/.MainActivity"
echo "\$ $ADB -s 127.0.0.1:5555 shell input tap 360 640   # 'Make Play Integrity Request'"
echo "\$ $ADB -s 127.0.0.1:5555 exec-out screencap -p > integrity-playcheck.png"
