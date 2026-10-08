# SKIRM-102 — evidencia (rojo → verde)

Rama `SKIRM-102-instagram-webhook-firma` sobre `origin/deploy/prod@5675ea0`. Node v22.23.3, pnpm 11.18.0, `pnpm install --frozen-lockfile` (el lockfile no cambia).

## Rojo: los tests nuevos contra el código del tronco

```
$ pnpm --filter ./shared exec tsx --test src/crypto/meta-signature.test.ts
# Error: Cannot find module './meta-signature'                      (la función no existía)

$ pnpm --filter ./connectors/instagram exec tsx --test src/webhook-signature.test.ts
not ok 1 - C2: no signature → 401 and nothing reaches the publisher      (200 !== 401)
not ok 2 - C2: malformed signature → 401
not ok 3 - C2: valid signature of another body, or of re-serialised JSON → 401
ok 4 - C2/C5: valid signature (any of the three app secrets) → 200 and the parsed event reaches publisher.publish
not ok 5 - F2-2: the dead keys of the prod Secret are not secrets of Meta
not ok 6 - C1b/F2-1: metaAppSecrets is the closed list, ...
not ok 7 - C2/F2-1: no secret configured → 503, ...
not ok 8 - F2-1: one secret set and the others empty → the empty key still does not pass
ok 9 - C4: GET verification keeps its behaviour with a token configured
not ok 10 - C4/F2-6: no WEBHOOK_VERIFY_TOKEN → GET answers 503 ...
not ok 11 - C4b/F2-4/F2-5: a rejected POST is never answered 200, ...
not ok 12 - F2-5: a log per rejection reason with a running count, ...
# tests 12 / # pass 2 / # fail 10
```

Los dos que pasan en rojo son la conducta que debe conservarse (firma buena → 200; GET con token configurado).

## Verde

```
$ pnpm --filter ./shared test
ok 1..5  (valid con uno o varios secretos; cabecera ausente / otro secreto / otro cuerpo / JSON reserializado;
          lista vacía; vacíos descartados; forma sha256=<64 hex> sin llegar a timingSafeEqual)
# tests 5 / # pass 5 / # fail 0

$ pnpm --filter ./connectors/instagram test        (la suite entera, con el fichero nuevo en la lista)
ok 42..53  (los 12 de webhook-signature.test.ts)
# tests 53 / # pass 53 / # fail 0

$ pnpm --filter ./shared --filter ./connectors/instagram --filter ./connectors/whatsapp-cloud build   → exit 0
$ pnpm --filter ./shared run lint                      → 0 errores (9 avisos que ya estaban)
$ pnpm contract:check                                  → Socialmedia contract OK (73 tools)
$ python3 scripts/render-connectors.py --check         → exit 0
$ pnpm --filter ./connectors/whatsapp-cloud test       → exit 0 sin ejecutar nada: ese paquete no tiene script `test`
$ pnpm -r --workspace-concurrency=1 --no-bail test
    shared 5/5 · instagram 53/53 · telegram 66/66 · whatsapp-synapse-bridge 40/40 · mcp-server 634 pasan, 8 skipped
    whatsapp-web: 537 pasan / 1 falla en el barrido y 0 en solitario (ver abajo)
```

`whatsapp-web`, `credential-session.test.ts`: en el barrido de `pnpm -r test` fallaron `write-back: saveCreds bursts
coalesce` (70) y `criterio 1d: tras connection open simulado hay exactamente 1 fila …` (293) con la concurrencia
por defecto, y solo el 293 en serie. Lanzada sola, la suite de `whatsapp-web` da 538 tests, 0 fallos, y
`credential-session.test.ts` sola dos veces da 10/10. Esta PR no toca `whatsapp-web` (solo añade un fichero a
`shared`); parece sensibilidad a la carga, pero no lo he comparado con el tronco.

## Mutación

Quitar el descarte de secretos vacíos en `verifyMetaSignature` (`.filter(() => true)`) rompe el test 4 de `shared`
(`empty secrets are dropped before comparing (F2-1)`); revertido.

## Una línea por criterio

- C1 · `shared/src/crypto/meta-signature.test.ts` (5 tests), en `scripts.test` de `shared/package.json`.
- C1b · tests 4 y 5 de `shared`; `metaAppSecrets` con el entorno de prod simulado (tests 6 y 7 de instagram); el espía de `timingSafeEqual` (test 5 de `shared`) no se llama con cabeceras mal formadas y sí con una buena.
- C2 · tests 1, 2, 3, 4 y 7 de `webhook-signature.test.ts` con `createInstagramApp` y `fetch`; fichero añadido a `scripts.test` de `connectors/instagram`.
- C3 · `whatsapp-cloud` compila (`build` exit 0) usando la función compartida; no tiene tests ni script `test`.
- C4 · tests 9 y 10; `git grep -n "instagram-verify-token"` sin resultados.
- C4b · test 11 (logger capturado: ni cuerpo ni firma) y que ningún rechazo devuelve 200.
- C5 · test 4: el evento parseado llega a `publisher.publish` con sus campos.
- C6 · `git grep -n -i "x-hub-signature"`: solo `shared`, `instagram/src/webhook.ts` y `whatsapp-cloud/src/webhook.ts` (más `CONTRACTS.yaml` y `ARCHITECTURE.md` en prosa).
- C7 · ver arriba.
- C8 · entrada `http.instagram-connector.webhook.v1` al final de `CONTRACTS.yaml`; trailer `Contract-Change: add http.instagram-connector.webhook.v1`.
