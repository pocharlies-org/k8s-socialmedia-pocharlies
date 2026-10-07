Rol: developer · Fecha: 2026-10-08 · Sesión: 715ef7e4-8c79-4f49-a12d-59a7c4339ea7 · Estado: LISTO

# SKIRM-110 · Entrega

PR: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies/pull/228 (rama `SKIRM-110-edge-lan-sso`, contra `deploy/prod`, que es lo que lee la Application `socialmedia`).

## Qué se hizo

- `scripts/render-connectors.py`, bloque `lan`: la ruta de todo el host (`Host(<lan_host>)`) lleva `middlewares: [{name: sso-chain, namespace: keycloak}]`. `/api/public` sigue con `connector-public-api-deny`, `/qr` con `sso-chain`. Comentario del bloque reescrito (decía que `/api/v1` y `/status` "stay reachable").
- `k8s/base/generated/connectors.yaml` regenerado: +9 líneas, tres bloques `middlewares` en las IngressRoute `whatsapp-lan`, `whatsapp-pro-lan`, `whatsapp-leila-lan`. `social-accounts.json` no cambia.
- `scripts/test_render_connectors.py`: la aserción del catch-all pasa de `[]` a `["sso-chain"]` y un test nuevo, `test_every_whatsapp_lan_host_is_behind_sso_chain`, recorre las tres cuentas reales del registro y exige `/api/public` con el deny, `/qr` y el catch-all con `{name: sso-chain, namespace: keycloak}`.
- `ARCHITECTURE.md` (C7): §8 describe el catch-all `.lan` tras `sso-chain` y que las máquinas usan el Service interno. Además las cuatro correcciones G-5 que el plan de SKIRM-99 (§10) encarga al primer maker que toque el fichero, cada una comprobada contra el código: `CONTRACTS.yaml` tiene 93 entradas (no 67); `accountKey` tiene tres copias (`connectors/whatsapp-web/src/db-writer.ts:40` además de `account.ts` y `db.py`); §1 lista `social-api`/`whatsapp-pairing`/`telegram-pairing` (`k8s/base/social-pairing.yaml`) y `dgx-messages`; §7 dice que el job de `telegram-sync` del CI levanta `postgres:16-alpine`. Se actualizó también el sha de `deploy/prod` y la fecha de "última verificación".
- No se toca el pod template, ni `CONTRACTS.yaml`, ni el CLAUDE.md (no habla de la exposición LAN de `/api/v1`). Contratos y migraciones: ninguno.

## Cómo verificarlo

```
python3 scripts/render-connectors.py --check            # exit 0
python3 -m unittest scripts/test_render_connectors.py   # Ran 8 tests ... OK
```

El test falla sin el cambio del generador (medido antes de tocarlo: 2 fallos, `whatsapp-lan` y `acme` con `[] != [sso-chain]`) y pasa después.

C3, el diff solo toca IngressRoute. Render de `kubectl kustomize k8s/overlays/prod` antes y después, comparado objeto a objeto (clave kind/namespace/name): 68 objetos, 3 con cambios, los tres `IngressRoute` `whatsapp-mcp/whatsapp-lan`, `whatsapp-leila-lan`, `whatsapp-pro-lan`. Deployments, Services y PVC idénticos. `git diff origin/deploy/prod -- k8s/` = 1 fichero, 9 inserciones.

`kubectl diff -k k8s/overlays/prod` (solo lectura) muestra las tres IngressRoute (`generation: 3` a `4` y el bloque `middlewares`) y ningún Deployment. Aparece además `Job/whatsapp-mcp-migrate` como alta (`@@ -0,0`): es el hook PreSync de ArgoCD con `hook-delete-policy: HookSucceeded`, que no existe en vivo entre syncs, y es igual en el render de antes y de después (no lo cambia esta PR). Un sync cualquiera lo vuelve a ejecutar.

## Checklist de 00-spec.md

- [x] C1. Test nuevo en `scripts/test_render_connectors.py` (catch-all con `sso-chain` en las tres cuentas); falla sin el cambio, pasa con él.
- [x] C2. `python3 scripts/render-connectors.py --check` verde.
- [x] C3. El diff del YAML generado solo toca objetos `IngressRoute` (comprobación arriba).
- [ ] C4. Tras merge y sync: 401/403/redirección sin credencial en `/api/v1/auth/qr`, `/status`, `/api/v1/health` de los tres hosts; `/qr/page` abre con SSO. Es de `qa` (agent-jake, headless), después del sync.
- [ ] C5. `restartCount` y `startTime` de los tres pods de WhatsApp sin cambio. Evidencia de `release`, antes y después del sync (el diff garantiza que ArgoCD no toca ningún Deployment).
- [ ] C6. `social_list_accounts` y una lectura de conversaciones por `/social` siguen funcionando (Service interno). De `qa`, después del sync.
- [x] C7. `ARCHITECTURE.md` §8 (y §1, §2, §4, §7 por G-5) actualizado.

El paso previo del spec (que nadie consuma `/api/v1/*` ni `/status` por los hosts `.lan`) es de `sre` y no lo he hecho yo; la PR no se debe fusionar antes de su nota.

## Reutilizado

- Usado del código existente: el propio generador (`scripts/render-connectors.py`, bloque `lan`, la ruta `/qr` que ya llevaba `{name: sso-chain, namespace: keycloak}`, copiada tal cual) y el Middleware `sso-chain` del ns `keycloak` que ya usa la IngressRoute `whatsapp-public` en `k8s/base/manifest.yaml`. El test amplía `test_new_whatsapp_account_renders_full_set` y reutiliza `rc.render`, `REGISTRY` y `rc.NAMESPACE` del módulo de tests.
- Buscado: `rg -n "sso-chain" k8s scripts`, `rg -n "lan\.e-dani\.com" -g '*.md' -g '*.yaml' -g '*.ts' -g '*.py'` (otros sitios que hablen de los hosts LAN: solo README y CLAUDE.md sobre `/qr/page`, correctos), `rg -n "accountKey|normalizeAccount"`, `rg -n "whatsapp-pairing|dgx-messages" k8s`, `rg -n "postgres" .github/workflows/ci.yml` (las cuatro comprobaciones de G-5). Detector de copias, `~/.local/libexec/x86-host-runtime/company-duplicados`: 85 fragmentos, todos en `connectors/` y `mcp-server/`, ninguno en un fichero de este diff (parece medir contra otra base: no lo he tocado).
- Escrito nuevo: un test (`test_every_whatsapp_lan_host_is_behind_sso_chain`), porque el existente solo usa una cuenta sintética `acme` y el criterio C1 pide cada cuenta real con el namespace de los middlewares. Nada más: ningún middleware, forwardAuth ni regla en `k8s-infra-pocharlies`.

## Riesgos y vuelta atrás

- Un cliente de máquina que llame a los hosts `.lan` (no al Service interno) recibirá la redirección a Keycloak: de ahí el paso previo de `sre`.
- Vuelta atrás: revertir la PR, una línea por ruta (quitar `middlewares` del `Host(...)` de `whatsapp.lan`, `whatsapp-pro.lan` y `whatsapp-leila.lan`); sin reinicios.
- Documento que refleja el cambio: `ARCHITECTURE.md` §8.
- Adyacente, fuera de alcance: `ALLOW_WEB_RENEW=true` deja `POST /qr/renew` sin autenticar para cualquier pod (professional y leila); para `security`/`sre`.
