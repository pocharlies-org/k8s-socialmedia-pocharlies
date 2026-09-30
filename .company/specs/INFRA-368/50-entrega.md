Rol: developer · Fecha: 2026-10-01 · Sesión: baf9713d-d2ef-4c98-a8a9-83d4e9e5b429 · Estado: LISTO

# INFRA-368 · P2 — entrega

PR: rama `INFRA-368-wa-voice-transcribe` contra `deploy/prod` (enlace en el comentario de Jira).

## Hecho
- `connector-urls.ts` (cuenta→URL de conector, del registro de cuentas); `server.ts::waUrl` la importa.
- Job `wa-voice-transcribe` (+lib+spec), `DRY_RUN=true` por defecto, concurrencia 1, relevo a omnivoice-audio.
- Migración 015 `brain_window_dirty` (ledger; `migrate.spec.ts` actualizado). Sin DDL en `messages`.
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
