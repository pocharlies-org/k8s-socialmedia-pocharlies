# Evidencia CI — sc1197-p4b-telegram-pairing (SC-1229, PR #85)

Fecha: 2026-09-25 · Rol: developer · Sesión: d39b53b3-5b4d-4fe2-9c40-11eee8fa6498
Rama: `sc1197-p4b-telegram-pairing` (base apilada `sc1197-p2-social-status`) · Head verificado: `614e7be`
Ejecutado en: worktree `/home/dibanez/k8s/k8s-socialmedia-pocharlies/.claude/worktrees/agent-ad6edede652472e1b`, working tree == commit.

## Qué fallaba (medido, no asumido)

`gh run view 36105861009 --log-failed` (PR #85, head `3ec12ec`):

```
connectors/telegram lint: /home/runner/.../connectors/telegram/src/pairing/test-fakes.ts
connectors/telegram lint:   19:70  error  'any' overrides all other types in this union type  @typescript-eslint/no-redundant-type-constituents
connectors/telegram lint: ✖ 136 problems (1 error, 135 warnings)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @mcp-socialmedia/telegram-connector@1.0.0 lint: `eslint src/**/*.ts`
```

Causa: el script `lint` del conector ejecutaba eslint sin construir `@mcp-socialmedia/shared`;
sin `shared/dist/index.d.ts`, `StoredCredential` resolvía a `any` y
`Promise<StoredCredential | null>` era `any | null`. No era el test de conteo del developer
anterior (su baseline ya estaba aplicada en `social-api.spec.ts:977`; las suites pasaban).

Segundo fallo, latente porque el `pnpm -r` abortaba en telegram (`gh run view 36109015918 --log-failed`, head `bb0184c`):

```
mcp-server lint:   13:9 / 18:9 / 35:9 / 90:40  error  prettier/prettier (4)
mcp-server lint: ✖ 1059 problems (4 errors, 1055 warnings)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @mcp-socialmedia/server@1.0.0 lint: `eslint src --ext .ts`
```

## Qué se cambió

- `bb0184c` (empujado en paralelo por la sesión que cosechó la rama): `"lint": "pnpm --filter @mcp-socialmedia/shared run build && eslint src/**/*.ts"` en `connectors/telegram/package.json` — mismo patrón que whatsapp-web (PR #70 verde). Cero cambio de alcance de ficheros linteados.
- `614e7be` (esta sesión): `eslint --fix` (prettier, solo formato) sobre `mcp-server/src/api/routes/me-telegram.ts`, `mcp-server/src/api/routes/pairing-telegram-password.ts`, `mcp-server/src/api/telegram-pairing-client.ts`.

## Verificadores sobre `614e7be`

| Mando | Resultado |
|---|---|
| `pnpm --filter @mcp-socialmedia/telegram-connector test` | PASS 38/38, 0 fail |
| `pnpm --filter @mcp-socialmedia/server test --runInBand` | PASS 332 passed, 8 skipped, 27 suites |
| `tsc --noEmit` en `connectors/telegram` y `mcp-server` | PASS 0 errores ambos |
| eslint `connectors/telegram` (glob del script, con shared construido) | PASS 0 errores (95 warnings preexistentes) |
| eslint completo `mcp-server` (`eslint src --ext .ts`) | PASS 0 errores (1055 warnings preexistentes) |
| `pnpm contract:check` | PASS `Socialmedia contract OK: sha256:29d060fa… (34 tools)` |
| `check-contracts.py` (k8s-gitops `origin/main`) `--range origin/sc1197-p2-social-status..HEAD` | PASS `contracts: OK (9 entries)` |

```
# tests 38
# pass 38
# fail 0

Test Suites: 1 skipped, 27 passed, 27 of 28 total
Tests:       8 skipped, 332 passed, 340 total

Socialmedia contract OK: sha256:29d060fab08e52ad05edf0e82204f5879aa8f550c809f6e88c5e52b580b845b4 (34 tools)
contracts: OK (9 entries in agent-ad6edede652472e1b)
```

Nota del arnés: el lint en worktrees anidados bajo `.claude/` recoge también el `.eslintrc.json`
del checkout padre (plugins duplicados); se ejecutó con
`--no-eslintrc -c <raíz>/.eslintrc.json --resolve-plugins-relative-to <raíz>`. Artefacto del
arnés ya documentado por otro developer; en CI el checkout es plano y no ocurre.

## Criterios del 00-spec.md

Los nueve criterios quedan verificados y marcados en `50-entrega.md` (sección «Criterios del
00-spec.md», todos `[x]`); esta evidencia añade la verificación de la CI, no nuevos criterios.

## Runs de la PR #85 (head final)

- pull_request run `36110288689`: SUCCESS (s3-tests, Lint/test/build, Contract surface, Build images, manifests — todo verde).
- push run `36110284115`: falló solo `Contract surface` porque su rango `bb0184c..614e7be` contenía únicamente el commit de formato; la regla del checker es mecánica (cualquier toque de fichero de superficie exige registry + trailer en el rango), y la vía `synapse-contracts` dice que un reformat que no cruza frontera de proceso no es un cambio de contrato. El commit de evidencia (solo `.company/`) adelanta el head para que el gate refleje la PR entera, cuyo rango sí lleva los trailers `Contract-Change: add …` de `3ec12ec`.
