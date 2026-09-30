Rol: developer · Fecha: 2026-10-01 · Sesión: baf9713d-d2ef-4c98-a8a9-83d4e9e5b429 · Estado: LISTO

# INFRA-368 · P2 — entrega

PR: rama `INFRA-368-wa-voice-transcribe` contra `deploy/prod` (enlace en el comentario de Jira).

## Hecho
- `connector-urls.ts` (cuenta→URL de conector, del registro de cuentas); `server.ts::waUrl` la importa.
- Job `wa-voice-transcribe` (+lib+spec), `DRY_RUN=true` por defecto, concurrencia 1, relevo a omnivoice-audio.
- Migración 017 `brain_window_dirty` (ledger; `migrate.spec.ts` actualizado). Sin DDL en `messages`.
- Telegram `complete_transcription`: UPDATE+INSERT en `conn.transaction()`, `transcribed_at`, `transcription_model`.
- CronJob `wa-voice-transcribe` (`7,37 * * * *`, Forbid, amd64/lan, imagen por digest vía `images` del overlay) **en `suspend: true`**: el digest del overlay (v1.3.76) es anterior al job; devops re-pina y lo activa.
- CLAUDE.md de SM actualizado. `BRAIN-INGEST-HANDOFF.md` no existe en `deploy/prod`.

## Tests (salida)
- `jest src/jobs/wa-voice-transcribe-lib.spec.ts`: 10 passed (selector, relevo 5xx/timeout/red, no relevo en 4xx, transacción commit/rollback/no-op, markFailed).
- `jest src/infrastructure/database/migrate.spec.ts`: 5 passed. Suite completa mcp-server: `credential-write-back` y `social-api` fallan también en el tronco (comprobado con stash); `migrate` falló por mi migración y está ajustado.
- `pytest connectors/telegram-sync/tests/test_transcription_dirty.py`: 3 passed (fixture de 20 audios: 20 UPDATE + 20 dirty; rollback si falla el INSERT).
- `kubectl kustomize k8s/overlays/prod`: rc=0, CronJob renderizado con `image …:v1.3.76@sha256:7b3d09a0…`.

## Criterios
- [ ] **Conteo previo ≈4.577 — NO medido.** El guard del rol deniega `kubectl exec` a Postgres. La consulta exacta es `COUNT_SQL` de `wa-voice-transcribe-lib.ts` (total / con adjunto / sin adjunto = residual); `DRY_RUN=true` la imprime antes/después. Pendiente: devops la ejecuta (solo lectura).
- [x] Unit del selector y del relevo con HTTP mockeado: verde.
- [x] Escritura transaccional (jest + pytest 20 audios): verde.
- [ ] `DRY_RUN` con 3 transcripciones reales: no ejecutado (se pidió no transcribir); lo hará devops con `kubectl create job --from=cronjob/wa-voice-transcribe`. Lee BD y conector y llama al STT; no escribe.
- [x] CronJob renderiza; CI pendiente.
- [x] Documentación: CLAUDE.md.

## Cómo verificar
`cd mcp-server && ./node_modules/.bin/jest src/jobs/wa-voice-transcribe-lib.spec.ts`; `python3 -m pytest connectors/telegram-sync/tests/test_transcription_dirty.py`.

## Rework 1 (CI rojo sobre 212833b) — causa de cada fallo
- **Lint, test, build**: 6 errores `prettier/prettier` en `wa-voice-transcribe.ts` (formato; no corrí eslint completo en local, solo jest/tsc). Arreglado con `eslint --fix`; ahora `eslint src --ext .ts` da 0 errores. Clase revisada: todos mis ficheros TS pasan eslint.
- **Contract surface**: `mcp-server/src/mcp/server.ts` es superficie de contrato y mi refactor de `waUrl` lo tocaba sin registry ni trailer. La causa real: el job es un consumidor nuevo de `GET /api/v1/messages/media/:chatId/:msgId`, que no estaba registrada. Entrada nueva `http.whatsapp-connector.messages-media-download.v1` (add) y trailer `Contract-Change: add http.whatsapp-connector.messages-media-download.v1`. La ruta no cambia.
- **Migración**: el tronco ya tiene `015_whatsapp_reaction_merge_backfills` (#151) y INFRA-370 (#152) usa la 016; la mía pasa a **017** (`migrate.spec.ts` actualizado). Sin dependencia de orden con la 016 (tablas independientes; el ledger es por nombre de fichero). Si #152 entra antes, su cambio en `migrate.spec.ts` (lista y posiciones) conflictúa con el mío: quien mergee segundo lo rebasa.
- Historia: el rebase obligaba a force-push (denegado), así que el delta va como commit normal encima de 212833b, sin reescribir.
- Tests tras el cambio: jest wa-voice + migrate 15 passed; pytest 3 passed; `kubectl kustomize` rc=0; eslint 0 errores; tsc sin errores nuevos.
