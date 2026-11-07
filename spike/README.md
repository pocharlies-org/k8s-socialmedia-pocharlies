# spike/ — SC-1244 (H1 del spike SC-1211): redroid + GMS + Instagram + Play Integrity

**Spike desechable.** Estos scripts existen solo para reproducir la evidencia de
viabilidad de la épica [SC-1211](https://e-dani.atlassian.net/browse/SC-1211),
parte P1 (historia SC-1244). No son producto: no se despliegan, no se mantienen,
y esta rama (`spike/sc1211-redroid`) no debe fusionarse nunca como base de nada.
El veredicto vive en los adjuntos de SC-1211 y en `50-entrega.md` de SC-1244.

## Qué mide

Android 13 en contenedor (redroid) con GMS sobre el x86 (docker puro, sin k8s),
instalación de la app oficial de Instagram y veredicto Play Integrity medido con
un checker open source. Criterios 1, 2 y 4 de la épica.

## Resultados medidos (2026-09-25, nodo `ubuntu`)

| Criterio | Resultado |
|---|---|
| 1 · redroid arranca con binder | PASS — `sys.boot_completed=1` (imagen base y con GMS) |
| 2 · GMS + Instagram instalados | PASS — `com.google.android.gms` + `com.android.vending` presentes; `com.instagram.android` v448.0.0.52.84 instalado (`pm list packages` → 1) |
| 4 · veredicto Play Integrity | **NO_INTEGRITY** — ningún nivel (ni BASIC, ni DEVICE, ni STRONG); App/Account `UNEVALUATED`. Adjunto `integrity-playcheck.png` en SC-1211 |
| extra · apertura de Instagram | CRASHEA a los 5 s: SIGSEGV en hilo `Lacrima_startup` bajo traducción arm64→x86_64 (`ndk_translation`). Adjunto `instagram-crash-logcat.txt` en SC-1211. Es evidencia para H2, no bloquea P1 (el criterio 2 solo pide instalación) |

## Fuentes oficiales consultadas

- redroid (imagen y requisitos de binder): <https://github.com/remote-android/redroid-doc> — tag usado `redroid/redroid:13.0.0-latest`.
- GMS vía estándar sin recompilar: <https://github.com/ayasa520/redroid-script> (commit `a4951b7`) con `-a 13.0.0 -mtg`, que integra <https://gitlab.com/MindTheGapps/vendor_gapps> vía releases de <https://github.com/s1204IT/MindTheGappsBuilder> (`MindTheGapps-13.0.0-x86_64-20240226.zip`, md5 verificado por el script).
- Instagram oficial: <https://github.com/EFForg/apkeep> 1.0.0, proveedor `apk-pure` (espejo de binarios firmados de Play; el proveedor `google-play` pidió credenciales y **no se logueó ninguna cuenta** — prohibido en el spike). Versión `448.0.0.52.84` (versionCode 385412061), splits `base + config.xxxhdpi`.
- Checker Integrity: <https://github.com/herzhenr/spic-android> release `v1.4.0` (`spic-v1.4.0.apk`). El spec citaba "Play Integrity Fork" (`osm0sis/PlayIntegrityFork`), que es un módulo Zygisk, no un checker; SPIC es el checker open source equivalente.
- adb: platform-tools `r36.0.0` oficiales de Google (<https://dl.google.com/android/repository/platform-tools_r36.0.0-linux.zip>), puerto atado a `127.0.0.1` solo (el README de redroid avisa de no exponer adb en red).

## Uso

```sh
./01-run-redroid.sh          # arranque base (criterio 1)
./02-build-gms-image.sh      # imagen 13.0.0_mindthegapps + contenedor con GMS
./03-sideload-apks.sh        # Instagram + SPIC (criterio 2)
./04-verify.sh               # comandos literales de verificación de los criterios
```

Requisitos del host: `binder_linux` cargado y `/dev/binderfs` montado (SC-1223),
docker, python3, ~6 GB libres. Los scripts usan `SCRATCH` (por defecto
`./work`) para descargas; nada de eso va al git.
