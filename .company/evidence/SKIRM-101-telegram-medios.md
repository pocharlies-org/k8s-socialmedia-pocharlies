# SKIRM-101-telegram-medios · evidencia rojo → verde

Dónde: x86 local, worktree de la rama; PostgreSQL 16 desechable (`docker run postgres:16`, `127.0.0.1:55432`) con
`TELEGRAM_SYNC_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres`. Python 3.12, pytest 8.3.3; Node 22, pnpm 11.

## Rojo (commit a721e9a: solo tests, sobre el código de deploy/prod)

```
telegram-sync  python -m pytest -rs --continue-on-collection-errors tests
  ERROR tests/test_media_recovery.py: ImportError: cannot import name 'media_recovery' from 'sync'
  FAILED test_media_backlog_postgres.py (x3): AttributeError: module 'sync.db' has no attribute
         'media_backlog' / 'pending_media' / 'record_media_result'
  3 failed, 16 passed, 1 error      (los 16 son los de antes + test_insert_message.py, verde sobre prod)

telegram  tsx --test src/download-deadline.test.ts
  not ok 1 - hung media download aborts the mtcute request after 120 seconds   (assert.ok(signal): sin plazo ni señal)
  tests 11, pass 0, fail 1, cancelled 10 (los otros diez cancelados por el colgado del primero)

telegram  tsx --test --test-name-pattern="single message and flood wait" src/download-deadline.test.ts
  not ok 1 - single message and flood wait HTTP contracts ...   404 !== 200   (la ruta messages/single no existe)
```

Aviso (G-4): el rojo por módulo o ruta ausente prueba que hay que portarlo, no que prod falle; el valor del recuperador lo da la medición del pin (`sre`).

## Verde (HEAD de la rama)

```
python -m pytest -p no:cacheprovider -rs -v tests          (con la variable de PostgreSQL)
  33 passed in 2.26s   -> 0 skipped
    test_edits 4 · test_insert_message 2 · test_media_backlog_postgres 3 · test_media_recovery 14 · test_voice_unwrap 10

pnpm --filter ./connectors/telegram exec tsx --test src/download-deadline.test.ts   -> tests 11, pass 11, fail 0
pnpm --filter ./connectors/telegram test                                           -> tests 77, pass 77, fail 0, skipped 0
pnpm -r build -> 0 · pnpm -r lint -> 0 (0 errores) · pnpm -r test -> 0
  instagram 41/41 · synapse-bridge 40/40 · telegram 77/77 · whatsapp-web 537 pass + 1 skipped previo · mcp-server 634 pass + 8 skipped previos
pnpm contract:check -> Socialmedia contract OK (73 tools)
python3 scripts/render-connectors.py --check -> exit 0 · python3 -m unittest scripts/test_render_connectors.py -> 7 OK
python3 ~/.config/git/check-contracts.py --repo . --range origin/deploy/prod..HEAD -> contracts: OK (94 entries)
```

Mutación: con `FOR UPDATE` quitado de `media_transaction`, `test_realtime_and_recovery_race_stores_one_attachment` falla
(`[True, True].count(True) == 1`); con él, pasa. La carrera la serializa la fila, no el lock del proceso (que el test anula).

Detector de copias (`company-duplicados`): ejecutado; ninguno de los fragmentos que lista cae en ficheros o líneas de este cambio (toma como «nuevo» casi todo el repo: su base no es `origin/deploy/prod`).

## Criterios

- C1 `pending_media`/`media_backlog` con SQL real: `test_media_backlog_postgres.py`, 3 pasan, 0 saltados.
- C2 429 con `Retry-After` y backoff con tope 3600: `test_rate_limit_and_backoff_schedule_the_next_retry` (SQL real) y `test_rate_limit_persists_retry_after_and_stops_batch`.
- C3 plazo de descarga: `download-deadline.test.ts` 11/11, incluido en `scripts.test` (77 en el paquete).
- C4 sin adjunto duplicado: `test_realtime_and_recovery_race_stores_one_attachment` (PostgreSQL real, mutación comprobada).
- C5 `test_insert_message.py`: verde sobre prod (a721e9a) y sobre HEAD; `insert_message_ex` no se tocó.
- C6 `messages-single.v1` nueva (`add`), nota de `messages-media-download.v1` ampliada (`migrate`), checker en verde.
- C7 suites completas verdes (arriba).
- C8 cada commit con código del fork lleva `Co-authored-by: jibanez-staticduo <staticduo@gmail.com>` y cita las rutas de origen.
- C9 `ARCHITECTURE.md`: §1, §2, §4, §6, §7, §8 y las cuatro contradicciones de G-5.
