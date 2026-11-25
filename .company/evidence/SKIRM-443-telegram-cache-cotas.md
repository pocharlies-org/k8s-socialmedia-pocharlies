# SKIRM-443 — evidencia (telegram-connector: cachés acotadas)

Rama: `SKIRM-443-telegram-cache-cotas` · Repo: k8s-socialmedia-pocharlies · Tronco: `deploy/prod`
Dónde se corrió: worktree `.claude/worktrees/SKIRM-443-cache-cotas`, node v22.23.4, pnpm 11.18.0.

## Comando y salida

`cd connectors/telegram && npm test` (tras `pnpm --filter @mcp-socialmedia/shared run build`)

```
# tests 148
# pass 140
# fail 0
# skipped 8        (los 8 son rutas de idempotencia que piden TELEGRAM_TEST_DATABASE_URL)
```

`cd connectors/telegram && npx tsc --noEmit` → sin errores.

`cd connectors/telegram && npx tsx --test src/bounded-storage.test.ts`

```
# tests 7
# pass 7
# fail 0
```

## Qué se cambió

- `connectors/telegram/src/bounded-storage.ts` (nuevo): `BoundedMap` (FIFO, tope por nº de
  entradas), `BoundedMemoryPeersRepository`, `BoundedMemoryRefMessagesRepository`,
  `BoundedMemoryStorage`, `capDialogs` y `cacheLimits` (topes por env, defaults 50000/50000/10000/2000).
- `connectors/telegram/src/telegram-client.ts`: `createTelegramStorage` (ruta house = cuenta
  personal) y `PersistHookedStorage` usan ya los repositorios acotados; `userNameCache` pasa a
  `BoundedMap`; el snapshot de dialogs de `getUnreadChats` se acota con `capDialogs`.
- `credential-session.test.ts`: el contrato de la ruta house pasa de «plain MemoryStorage» a
  «BoundedMemoryStorage sin persist-hook» (el arreglo exige acotar también la cuenta personal).
- `package.json`: `bounded-storage.test.ts` añadido a `npm test`.

## Criterios de aceptación

- **C3 (tests de desalojo en las tres cachés + liberación del backfill)** — CUMPLE en código:
  `bounded-storage.test.ts` demuestra desalojo en peers (`entities` + índices), mensajes
  (`refMessages.refs`) y dialogs (`capDialogs` + `userNameCache`), y que el `MemoryStorage` por
  defecto sigue sin desalojar (el arreglo está en el subclase, no en la librería). `npm test` verde.
  El despliegue NO sube el límite (3Gi intacto en telegram_defaults: este PR no toca k8s/).
- **C1 (24 h sin OOMKilled)** — NO verificable en esta PR: es una medida en producción tras
  desplegar. El test que «debe fallar primero» está y pasa: `plain MemoryPeersRepository grows
  unbounded` documenta el crecimiento sin cota del código anterior; el de la variante acotada exige
  desalojo y pasa.
- **C2 (working set < 50 Mi/h en 24 h)** — NO verificable en esta PR: medida en VictoriaMetrics
  tras desplegar.
- **C4 (bucle «Peer ... is not found in local cache» = 0)** — el bucle ya lo trata SC-1500
  (`peer-resilience.test.ts`, ya en el tronco): un peer ausente se re-resuelve por la API en vez de
  tumbar el ciclo. Acotar la caché no lo empeora (un peer desalojado se re-resuelve y se re-guarda);
  la medida de 72 h es de producción.

## Fuera de alcance (declarado)

No se toca el dimensionamiento (3Gi), el connector professional ni telegram-sync. No se cambian
contratos de `CONTRACTS.yaml` (ninguna superficie pública alterada). El telegram-connector no tiene
buffer propio de backfill tipo `WA_RECONNECT_BACKFILL_*` (eso es de whatsapp-web); su equivalente —
el snapshot de dialogs que recorre `iterDialogs`— es lo que se acota con `capDialogs`.
