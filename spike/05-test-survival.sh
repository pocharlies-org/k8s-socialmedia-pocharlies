#!/usr/bin/env bash
# SC-1248 P1b · test de supervivencia: ¿aguanta la app OFICIAL de Instagram abierta
# >= 60 s en redroid sin crashear, y se ve la pantalla de login? (sin credenciales).
# Uso: ./05-test-survival.sh <etiqueta-via>   (p. ej. houdini | x8664)
# Vías estándar únicamente: se lanza el launcher con monkey, se espera 60 s, se mira
# pidof dentro del contenedor y se captura la pantalla. Logcat de la ventana guardado
# como evidencia en SCRATCH/instagram-crash-logcat-<etiqueta>.txt (o -<etiqueta>-viva).
set -uo pipefail

SPIKE_DIR=$(cd "$(dirname "$0")" && pwd)
SCRATCH=${SCRATCH:-$SPIKE_DIR/work}
ADB=${ADB:-$SCRATCH/platform-tools/adb}
LABEL=${1:?etiqueta de via (houdini|x8664)}
CONTAINER=${CONTAINER:-redroid}
PKG=com.instagram.android

"$ADB" connect 127.0.0.1:5555 >/dev/null
echo "bridge activo: $(docker exec "$CONTAINER" getprop ro.dalvik.vm.native.bridge)"
echo "instalada: $(docker exec "$CONTAINER" dumpsys package "$PKG" | grep -m1 versionName)"

# logcat de fondo para la ventana del test
"$ADB" -s 127.0.0.1:5555 logcat -c
"$ADB" -s 127.0.0.1:5555 logcat -v time > "$SCRATCH/logcat-$LABEL.raw" 2>&1 &
LOGCAT_PID=$!

# 1. lanzar por el launcher oficial (sin tocar credenciales: la app no tiene cuenta).
#    monkey -c LAUNCHER aborta con -5 con los alias de tema de Instagram; el spec admite
#    am start -n con el launcher que resuelve `cmd package resolve-activity`:
#    com.instagram.android/com.instagram.activity.MainTabActivity
ACT=$(docker exec "$CONTAINER" cmd package resolve-activity --brief "$PKG" | tail -1)
docker exec "$CONTAINER" am force-stop "$PKG"   # UI de verdad: sin procesos previos del boot receiver
sleep 2
"$ADB" -s 127.0.0.1:5555 shell am start -n "$ACT"

# 2. esperar 60 s
sleep 60

# 3. vive? (pidof + foco: pidof solo engaña — el boot receiver deja procesos en background)
PID=$(docker exec "$CONTAINER" pidof "$PKG" | awk '{print $1}')
FOCUS=$(docker exec "$CONTAINER" dumpsys window | grep -m1 mCurrentFocus)
echo "foco: $FOCUS"
if [ -n "$PID" ] && echo "$FOCUS" | grep -q "$PKG"; then
  echo "RESULTADO: VIVA a los 60 s EN PRIMER PLANO · pidof=$PID · $FOCUS"
  OUT="$SCRATCH/instagram-crash-logcat-$LABEL-viva.txt"
  # 4. captura de pantalla (se revisa a mano: debe ser la pantalla de login)
  "$ADB" -s 127.0.0.1:5555 exec-out screencap -p > "$SCRATCH/pantalla-$LABEL.png"
  echo "captura: $SCRATCH/pantalla-$LABEL.png"
else
  echo "RESULTADO: NO SUPERVIVE EN PRIMER PLANO a los 60 s · pidof='${PID:-vacio}' · foco='$FOCUS'"
  OUT="$SCRATCH/instagram-crash-logcat-$LABEL.txt"
fi

kill $LOGCAT_PID 2>/dev/null
grep -aE 'Fatal|SIGSEGV|libc |DEBUG|AndroidRuntime|nativebridge|houdini|ndk_translation' \
  "$SCRATCH/logcat-$LABEL.raw" | tail -300 > "$OUT"
echo "evidencia: $OUT"
