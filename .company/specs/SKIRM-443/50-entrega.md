Rol: developer · Fecha: 2026-11-25T00:00:00Z · Sesión: 123049e6-004b-4c0c-a859-f48ac026ac49 · Estado: LISTO

# SKIRM-443 — entrega

## Qué se hizo

Acotadas en código las cachés del telegram-connector que hacían crecer el pod hasta OOM
(INFRA-928). mtcute `MemoryStorage` guarda peers y referencias de mensaje en `Map` sin desalojo;
se sustituyen por variantes con tope por nº de entradas (FIFO), se acota el snapshot de dialogs y
`userNameCache`. El límite de 3Gi del pod deja de ser la única cota.

- PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/521 (base `deploy/prod`).
- Ficheros: `connectors/telegram/src/bounded-storage.ts` (nuevo) y su test, `telegram-client.ts`,
  `credential-session.test.ts`, `package.json`.

## Cómo verificar

- `cd connectors/telegram && npm test` → 148 tests, 140 pasan, 0 fallan (8 saltan por faltar
  `TELEGRAM_TEST_DATABASE_URL`). `npx tsc --noEmit` limpio.
- `npx tsx --test src/bounded-storage.test.ts` → 7/7: demuestra desalojo en peers, mensajes y
  dialogs, y que el `MemoryStorage` por defecto sigue sin desalojar.
- Evidencia completa: `.company/evidence/SKIRM-443-telegram-cache-cotas.md`.

## Checklist de 00-spec.md

- [x] C3 — tests de desalojo en las tres cachés + snapshot de dialogs acotado; `npm test` verde; el
  despliegue NO sube el límite (3Gi intacto, no se toca k8s/).
- [ ] C1 — 24 h sin OOMKilled: medida de producción tras desplegar (fuera de esta PR).
- [ ] C2 — working set < 50 Mi/h en 24 h: medida en VictoriaMetrics tras desplegar.
- [ ] C4 — bucle «Peer ... is not found in local cache» = 0 en 72 h: ya lo trata SC-1500 (en el
  tronco); la medida es de producción.

## Reutilizado

- Buscado con `rg`: `rg -n "not found in local cache" node_modules/.pnpm/@mtcute+core@0.29.7` (origen
  del error), `rg -n "new Map\(|cache" connectors/telegram/src` (cachés propias), y el patrón ya
  existente `userNameCache` acotado a mano en `telegram-client.ts` (sustituido por `BoundedMap`).
- Reutilizado: la extensión de storage que ya existía (`HookedMemoryStorageDriver` /
  `PersistHookedStorage`, SC-1145) — los repositorios acotados se conectan ahí, sin tocar la librería
  ni el hook de persistencia. `MemoryStorageDriver`/`Memory*Repository` ya exportados por
  `@mtcute/node`.
- Escrito nuevo y por qué: `BoundedMap` y los dos repositorios acotados — mtcute no ofrece desalojo en
  sus repositorios en memoria (solo un `LruMap` interno de 100/1000 en el servicio, que no limita el
  repositorio subyacente, que es lo que crecía).

## Riesgos / fuera de alcance

- Tope FIFO: un peer activo puede desalojarse y re-resolverse por la API (lo que ya hace
  `resolve-peer` / SC-1500). Defaults 50000/50000/10000/2000, ajustables por env
  (`TG_PEERS_CACHE_MAX`, `TG_REFMSGS_CACHE_MAX`, `TG_DIALOGS_MAX`, `TG_USERNAME_CACHE_MAX`).
- El telegram-connector no tiene buffer propio de backfill tipo `WA_RECONNECT_BACKFILL_*` (eso es de
  whatsapp-web); su equivalente — el snapshot de dialogs — es lo que acota `capDialogs`.
