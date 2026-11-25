# Evidencia INFRA-1561 — candidatos por último veredicto y cierre del dm pendiente

Rama `feat/INFRA-1561-cobertura-candidatos` sobre `origin/deploy/prod` (e94ec37).
Ejecutado en el worktree `/home/dibanez/k8s/wt-INFRA-1561` (node 22.23.4, pnpm workspace).

## Rojo (antes del fix)

Se retiró SOLO `sauvage-verificacion/src/moderacion.ts` (`git stash push -- …`), dejando los
tests nuevos y el resto del diff intactos, y se corrió `pnpm tsx --test src/moderacion.test.ts`:

```text
not ok 19 - C1 (INFRA-1561): el fallo al expulsar a un miembro no deja sin acción a los candidatos que vienen después
  ---
  failureType: 'testCodeFailure'
  error: |-
    el candidato de la pasada anterior recibe su dm y luego su ban pese al fallo del otro
    + actual - expected

    + []
    - [
    -   'dm',
    -   'ban'
    - ]
```

Resumen de la corrida roja: `# tests 22 / # pass 20 / # fail 2` — fallan el test C1 de arriba
(y el candidato de la pasada anterior sale con **cero acciones**, la forma medida del defecto) y
el cierre del pendiente como `cumplido`. Los 18 tests previos (PR 519) pasan ya en rojo.

## Verde (con el fix)

`pnpm test` en `sauvage-verificacion/` (script del paquete: build de `@mcp-socialmedia/shared` +
`tsx --test` de los 9 ficheros):

```text
1..54
# tests 54
# pass 54
# fail 0
```

Incluye los 6+ tests de la PR 519 (C3/C4/C7 de la épica) y los 3 nuevos de INFRA-1561.

## tsc

`pnpm exec tsc --noEmit` en `sauvage-verificacion/`: salida vacía, exit 0.

## Suite completo del monorepo

`pnpm test` en la raíz: todos los paquetes verdes salvo un único test de
`connectors/whatsapp-web` (`criterio 1f: loggedOut → fila borrada, estado expired`, en
`src/pairing/session-pool.test.ts`) que falló bajo la carga de la corrida paralela.
Repetido solo ese fichero: 13/13 verde. Repetida la suite entera del paquete:
`# tests 1016 / # pass 1015 / # fail 0`. Sensibilidad al timing del test, no del cambio:
esta PR no toca `connectors/whatsapp-web` (el diff solo toca `sauvage-verificacion/` y `docs/`).

## Criterios

- C1: rojo→verde arriba; candidato de pasada anterior (721652387, id real medido) recibe `dm`
  y luego `ban` pese al fallo del miembro iterado antes (6468280801, forma medida del 23-11).
- C2: pendiente registrado (`pendiente/ban_fallo`) al fallar el ban tras el dm; la pasada
  siguiente lo cierra expulsando sin reenviar la guía (test «el pendiente se cierra…»), y con
  último veredicto `cara` lo cierra como `cumplido` sin tocarle (segundo test C2).
- C3: `construirInforme` lleva `moderacion (candidatos=N avisados=N expulsados=N)` y lista los
  candidatos sin acción (test C3 en `informe.test.ts`: 721652387 sale visible).
- C4: los 18 tests previos de `moderacion.test.ts` (PR 519) verdes en rojo y en verde;
  `dudoso`/`no_auditar` siguen sin expulsar (test 5).
