# Evidencia INFRA-745 (2a vuelta) — savage_pasadas captura el ses_ de la salida del run

Rama: `feat/INFRA-745-ses-capture-stdout` · Repo: `pocharlies-org/k8s-socialmedia-pocharlies` · Tronco: `deploy/prod`
Ejecutado en `/home/dibanez/k8s/k8s-socialmedia-pocharlies/.claude/worktrees/INFRA-745-ses-capture-stdout` (node 22, pnpm 11.18.0).

## Estado real del entorno destino (un 200 no basta — evidencia pedida por el supervisor para C1)

Medido el 19-11 con `KUBECONFIG=~/.kube/config kubectl logs -n whatsapp-mcp job/sauvage-verificacion-diaria-29917770` (pasada real del 19-11):

- La sesion EXISTE y sale en la salida del `opencode run`:
  `timestamp=2026-11-19T05:30:18.800Z level=INFO run=858a96ea message=created id=ses_e0db736cfffe2WYzjUMQZouCCx slug=swift-mountain version=1.18.30 projectID=global directory=/app/sauvage-verificacion ...`
- El bot, con el resolvedor del fix original (PR 492), registro la fila sin id:
  `pasada-sesion ses=desconocido` (linea 581 del mismo log) y `barrido total=354 auditados=59 no_auditados=1`.
- Los ids `ses_` reales son `ses_` + 26 caracteres (`ses_e0db736cfffe2WYzjUMQZouCCx` del 19-11; `ses_e12dd84e7ffeacjasU5QRKXUsF` del 18-11, copiado por qa). El patron `ses_` + 22 del fix original no corresponde.

Causa del fallo, reproducida localmente el 19-11 (`npm install opencode-ai@1.18.30` en un directorio aparte, `HOME`/`XDG_DATA_HOME` aislados, `opencode run --pure --auto --print-logs -m litellm/fake`):

- opencode-ai 1.18.30 NO escribe `storage/session/<proyecto>/ses_*.json`: su unico estado de sesiones es SQLite (`<XDG_DATA_HOME>/opencode/opencode.db`). El arbol creado por el run: `opencode/opencode.db{,-wal,-shm}` y `opencode/log/opencode.log`. Por eso `resolverSesionOpencode` devolvia `null` SIEMPRE en el job real.
- La salida del run SIEMPRE esta en `<XDG_DATA_HOME>/opencode/log/opencode.log`: las mismas lineas que `--print-logs` vuelca a stdout (verificada: contiene `message=created id=ses_e0c27134affe14RpVFAH63Swkw ...`). El bot no puede leer la stdout del contenedor; si puede leer este fichero.

## Test rojo-primero (nuevo fichero `sauvage-verificacion/src/sesion-salida.test.ts`)

El test lanza la pasada contra un falso `opencode run`: un `opencode.log` falso con las lineas copiadas literalmente del job real (id real de 26 chars del 18-11), almacenamiento inexistente (como en el job).

ROJO, ejecutado ANTES del fix (`npx tsx --test src/sesion-salida.test.ts`):

```
TAP version 13
# Subtest: C1 (rojo sin el fix): la fila lleva el ses_ capturado de la salida del run
not ok 1 - C1 (rojo sin el fix): la fila lleva el ses_ capturado de la salida del run
  ---
  duration_ms: 5.335559
  type: 'test'
  failureType: 'testCodeFailure'
  error: 'la fila lleva el id de la salida del run (formato real, 26 chars), got ["professional",null]'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  ...
# Subtest: C1: sin salida del run ni almacenamiento la pasada sigue y deja su fila con sesion NULL
ok 2 - C1: sin salida del run ni almacenamiento la pasada sigue y deja su fila con sesion NULL
# Subtest: C1: sin linea de sesion en la salida, la pasada cae al almacenamiento (fallback)
ok 3 - C1: sin linea de sesion en la salida, la pasada cae al almacenamiento (fallback)
1..3
# tests 3
# pass 2
# fail 1
```

El fallo es exactamente el defecto de qa: la fila sale `["professional", null]` aunque la salida del run lleva el `ses_`.

VERDE, ejecutado DESPUES del fix (`npx tsx --test src/sesion-salida.test.ts`):

```
ok 1 - C1 (rojo sin el fix): la fila lleva el ses_ capturado de la salida del run
ok 2 - C1: sin salida del run ni almacenamiento la pasada sigue y deja su fila con sesion NULL
ok 3 - C1: sin linea de sesion en la salida, la pasada cae al almacenamiento (fallback)
ok 4 - capturarSesionDeSalida: gana la linea message=created sobre session.id
ok 5 - capturarSesionDeSalida: sin created, vale session.id (el mas reciente)
ok 6 - capturarSesionDeSalida: salida sin ningun ses_ es null (sin lanzar)
ok 7 - leerSesionDeSalidaDelRun: fichero inexistente es null (sin lanzar)
# tests 7
# pass 7
# fail 0
```

## Suite completa y tipos

`pnpm test` (en `sauvage-verificacion/`, tras `pnpm --filter @mcp-socialmedia/shared run build`):

```
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`npx tsc --noEmit` (en `sauvage-verificacion/`): sin errores (salida vacia, exit 0).

## Criterios

- C1 (cada pasada en su propia sesion de opencode, evidencia estable en `savage_pasadas`): la fila lleva ahora el `ses_` capturado de la SALIDA del run (`opencode.log`, linea `message=created id=ses_...`, con fallback al almacenamiento); verificado rojo→verde arriba con la forma real del id (`ses_` + 26, no hardcodeado). La medida en el job real (arriba) acredita que la fuente existe SIEMPRE en el entorno destino.

## Nota secundaria: la pasada del 17-11 termino Failed

El cierre de pasada NO pudo lanzar el error: `registrarPasada` va envuelto en `try/catch` en `ejecutarPasada` (fallo blando: loguea `pasada-sesion: registro en BD fallo (...); la pasada sigue` y la pasada termina). El exit code del contenedor es el de `opencode run` (`k8s/base/sauvage-verificacion.yaml`: `rc=$?; ...; exit $rc`), asi que el Failed viene del proceso opencode (o del pod), no del codigo del bot. No es recuperable desde el codigo: el pod del job 29914890 ya lo borro el pod-reaper (`kubectl logs` → `timed out waiting for the condition`; el pod no existe). Queda como nota para el operador si quiere el por menor (Loki o re-executar a mano).
