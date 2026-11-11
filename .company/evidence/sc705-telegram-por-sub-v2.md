# Evidencia — sc705-telegram-por-sub-v2 (SC-1145, SC-705 P2 Telegram por sub)

Medido 2026-10-31 en el worktree de la rama (base `origin/deploy/prod@be8d300`), máquina `x86`.

## C1 — registro + re-render

- `python3 scripts/render-connectors.py` → `wrote k8s/base/generated/connectors.yaml`, `wrote k8s/base/generated/social-accounts.json`. Diff del generated **puramente aditivo**: 372 líneas añadidas, 0 borradas (los documentos de casa byte-idénticos).
- `python3 scripts/render-connectors.py --check` → sin cambios pendientes (PASS).
- `python3 -m unittest scripts/test_render_connectors.py` → `Ran 8 tests ... OK` (PASS).

## C1 (lección P1) — defaultRegistry + spec

Comando: `pnpm --filter @mcp-socialmedia/server test --runInBand` (tras `pnpm install --frozen-lockfile`).

```
PASS src/domain/account-registry.spec.ts
Test Suites: 7 skipped, 74 passed, 74 of 81 total
Tests:       19 skipped, 915 passed, 934 total
EXIT=0
```

Suite COMPLETA verde local antes del push (PASS; mismo recuento que el baseline de P1: 74 suites / 915 tests — los cambios añaden aserciones dentro de tests existentes, no tests nuevos).

## C2 — overlay renderizado

Comando: `kubectl kustomize k8s/overlays/prod` (KUBECONFIG=~/.kube/config) → exit 0, 4054 líneas. Extracción de los Deployment afectados:

```
### telegram-connector                              (casa — sin cambio)
image: .../whatsappmcp-telegram-connector:v1.3.133@sha256:d21bb7e8efba8c8eaa8865f5b5aa5cdfd18ffdde7fcc01f6c1f12402a633915d
  envFrom: ['whatsapp-mcp-secrets']
### telegram-connector-daniel                       (nuevo)
image: .../whatsappmcp-telegram-connector:v1.3.133@sha256:d21bb7e8efba8c8eaa8865f5b5aa5cdfd18ffdde7fcc01f6c1f12402a633915d
  env TELEGRAM_SESSION_STRING = ''
  env CREDENTIAL_STORE_ENABLED = 'true'
  env CREDENTIAL_SESSION_KEY = 'e51253a7-c137-4c6c-9fb9-af9cecd3b147'
  env CONNECTOR_ACCOUNT = 'daniel'
  envFrom: ['whatsapp-mcp-secrets']
### telegram-connector-leila                        (nuevo)
image: .../whatsappmcp-telegram-connector:v1.3.133@sha256:d21bb7e8efba8c8eaa8865f5b5aa5cdfd18ffdde7fcc01f6c1f12402a633915d
  env TELEGRAM_SESSION_STRING = ''
  env CREDENTIAL_STORE_ENABLED = 'true'
  env CREDENTIAL_SESSION_KEY = '66ec6f4f-5f2c-44f6-a3db-0dccba6e1748'
  env CONNECTOR_ACCOUNT = 'leila'
  envFrom: ['whatsapp-mcp-secrets']
### telegram-connector-professional                 (casa — sin cambio)
image: .../whatsappmcp-telegram-connector:v1.3.133@sha256:d21bb7e8…
  env CONNECTOR_ACCOUNT = 'professional'
  env TELEGRAM_SESSION_STRING = 'secretKeyRef:TELEGRAM_SESSION_STRING_PROFESSIONAL'
  envFrom: ['whatsapp-mcp-secrets']
### telegram-sync                                   (casa — sin cambio)
image: .../whatsappmcp-telegram-sync:v1.3.110@sha256:d8f1e7bb12d930e6447d2270cf714275fa350e9899f1594c47f8c45c2a642b1e
### telegram-sync-daniel                            (nuevo)
image: .../whatsappmcp-telegram-sync:v1.3.110@sha256:d8f1e7bb…   (bloque images: del kustomization)
  env CONNECTOR_ACCOUNT = 'daniel'
### telegram-sync-leila                             (nuevo)
image: .../whatsappmcp-telegram-sync:v1.3.110@sha256:d8f1e7bb…   (bloque images: del kustomization)
  env CONNECTOR_ACCOUNT = 'leila'
### whatsapp-connector                              (casa — cero regresión)
image: .../whatsappmcp-whatsapp-connector:v1.3.120@sha256:d2aba25a…
  env CREDENTIAL_STORE_ENABLED = 'false'
```

PASS — pins del inventario 29089 exactos; vaciado H2 presente; casa intacta.

## C3 — check-social-isolation extendido a telegram

- Sintaxis: `python3 -c "import ast; ast.parse(...)"` → OK (PASS).
- Sondeo ahora por par (canal, cuenta); las entradas telegram se llaman con `channel: "telegram"` explícito; whatsapp sigue con `{"accountId": ...}` idéntico a P1.
- La ejecución contra lo vivo con sesiones reales se mide tras el despliegue (cierre de épica, como en P1).

## C4 — cero regresión en casa

En el render: `telegram-connector` y `telegram-connector-professional` sin ningún env nuevo (su `TELEGRAM_SESSION_STRING` sigue envFrom/secretKeyRef de siempre); `whatsapp-connector` sigue con `CREDENTIAL_STORE_ENABLED=false`. PASS a nivel manifiesto; pods Ready se verifica tras el sync (no es medible en la PR).

## C5 — CrashLoop esperado

Declarado en la PR y en el 50-entrega (H3). El log de un arranque real se pega tras el despliegue.

## C6 — ARCHITECTURE.md §8

Nuevo bullet «Serving por sub en Telegram (SC-705/SC-1145, P2 del mismo camino)» con sessionSecretKey null, vaciado H2 y CrashLoop H3. PASS.
