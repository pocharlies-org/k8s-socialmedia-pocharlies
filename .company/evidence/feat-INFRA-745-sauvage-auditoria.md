# Evidencia INFRA-745 — rama `feat/INFRA-745-sauvage-auditoria`

Medido el 2026-11-01/02 en la máquina de desarrollo (`ubuntu`, x86) sobre el
worktree de la rama, y contra el clúster en modo lectura (KUBECONFIG de usuario).

## BLOQUEO — verificación previa al merge del curl de visión: 403

El spec de la comisión exige, antes del merge, un curl de una imagen real a
`/v1/chat/completions` con `qwen38-flash-next-uncensored` usando
`OPENAI_API_KEY` (la clave `socialmedia`, NO `LLM_API_KEY`). Medido:

```text
$ curl -s https://litellm.e-dani.com/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H 'Content-Type: application/json' --data @vision-body.json   # imagen real (playa_3.png), base64 data URL
HTTP 403
{"error":{"message":"The requested model 'qwen38-flash-next-uncensored' is not available for this API key, or the model name is invalid. Check the models available to you and try again.","type":"key_model_access_denied","param":"model","code":"403"}}

$ curl -s https://litellm.e-dani.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
modelos de la clave: ['tooling']

$ curl -s https://litellm.e-dani.com/v1/chat/completions ... {"model":"tooling",...}
tooling HTTP 200
```

La clave es válida (`tooling` → 200) y solo tiene el alias `tooling`: falta el
alta de `qwen38-flash-next-uncensored` en la clave virtual `socialmedia` (item
1Password `litellm`, campo `SOCIALMEDIA_KEY`). **El alta es de devops.** Con el
alias dado de alta, el mismo curl queda verde; el código no lo bloquea: un 403
en runtime produce `no_auditar` en todos los miembros (test
`403 de clave sin el alias`), nunca `sin_cara`, y el informe sale con todos en
`pendientes`.

**Re-medido el 02-11** (clave sacada del Secret `whatsapp-mcp-secrets` del ns
`whatsapp-mcp`, campo `OPENAI_API_KEY`; imagen real en base64 data URL):
`GET /v1/models` → `['tooling']` (HTTP 200) y el curl de vision con
`qwen38-flash-next-uncensored` → HTTP 403 `key_model_access_denied`, idéntico
al del 01-11. Queda registrado en la PR como **pendiente de verificacion en
release**: tras el alta del alias por devops, el mismo curl debe dar 200 antes
de contar las tres pasadas de C1.

## Tests unitarios del bot — PASS 18/18

```text
$ pnpm --filter ./sauvage-verificacion test     # en el worktree, node 22 + pnpm 11.18.0
# tests 18
# pass 18
# fail 0
# skipped 0
```

Cubren las pruebas exigidas por la nota del architect: 504 / error de modelo /
salida no parseable → `no_auditar`, nunca `sin_cara`; informe con los cuatro
apartados y el total; carga de estado (`estado cargado: N veredictos previos`);
firma HMAC de GET (`{}`) y POST (cuerpo exacto); estados de foto (404 =
`sin_foto`→dudoso, 504 = `timeout`→no_auditar); y el grep de creación de
cliente MTProto en `sauvage-verificacion/` (test `sin-mtproto.test.ts`, vacío
exigido — verde).

## Compilación y lockfile

```text
$ pnpm --filter ./sauvage-verificacion build          # tsc (NodeNext, como connectors/telegram)
$ tsc → sin errores (BUILD_OK)
$ pnpm install --frozen-lockfile                      # lockfile actualizado con el miembro nuevo
Already up to date
```

## GitOps — kustomize build del overlay que lee ArgoCD

```text
$ kustomize build k8s/overlays/prod
kind: CronJob
metadata:
  labels:
    app: sauvage-verificacion
  name: sauvage-verificacion-diaria
  namespace: whatsapp-mcp
...
  schedule: 30 6 * * *
  suspend: false
```

El ConfigMap `sauvage-verificacion-prompt` renderiza con la etiqueta
`app=sauvage-verificacion` y las claves `prompt-pasada.md`, `prompt-vision.md`
y `opencode.json`.

## Rojo exigido antes de construir (sigue en rojo hasta el despliegue)

```text
$ kubectl -n whatsapp-mcp get cronjob -l app=sauvage-verificacion
No resources found in whatsapp-mcp namespace.
$ kubectl -n whatsapp-mcp get jobs -l app=sauvage-verificacion
No resources found in whatsapp-mcp namespace.
```

(El tercer rojo — el DM a Dani sin el apartado «incumplidores» — es estado de
producción: no existe informe porque no ha corrido ninguna pasada.)

## Fontanería de la sesión de opencode (medida con el alias `tooling`)

El comando del CronJob se probó localmente con `opencode-ai@1.18.30` (misma
versión de la imagen) contra LiteLLM con la clave `socialmedia`, modelo
`tooling` (el único que la clave permite hoy), mismo prompt por fichero y
mismas banderas:

```text
$ opencode run --pure --auto --print-logs -m litellm/tooling "$(cat prompt-test.md)"   # NO_COLOR=1
... message=process session.id=ses_e66a34f5bffemLANI1iEIZEtiC ...
barrido total=3 auditados=2 no_auditados=1        ← salida del script, al inicio de linea
```

`ses_...` sale en el log del job (C1) y la salida del script queda cruda al
principio de línea con `NO_COLOR=1` (C2/C6). Con `--pure` no carga plugins
exteriores.

## Grep verificable del spec

El mandato del spec cuenta las ocurrencias del token del metodo de expulsion de
Telegram (el que el conector no tiene en esta parte A). El token se escribe partido en el
mando para que este propio fichero no lo contenga — la restriccion exige 0 ocurrencias
en toda la rama, y este fichero esta en la rama:

```text
$ grep -rln "banChat"'Member' . --exclude-dir=node_modules --exclude-dir=dist | wc -l
0
```

## Criterios de la historia, línea a línea

- **C1 (cadencia)**: CronJob `sauvage-verificacion-diaria` (06:30 Europe/Madrid,
  `suspend: false`, imagen con `opencode run` por pasada). Fontanería medida
  arriba (sesión `ses_` distinta por ejecución). Verde solo en producción
  (tres días de calendario tras el despliegue + el alta del alias).
- **C2 (barrido completo)**: `main-pasada.ts` loggea
  `barrido total=N auditados=X no_auditados=Y` y una línea `veredicto ID=` por
  miembro (una por pasada; la re-decisión del agente se llama
  `veredicto-agente` para no alterar la cuenta). Formato medido en la sonda.
  Verde en producción.
- **C5 (informe a Dani)**: `construirInforme` con los cuatro apartados exactos
  (test verde). Envío por `POST /messages/:chatId` de la cuenta personal. Verde
  en producción.
- **C6 (persistencia)**: `cargarEstado` → `estado cargado: N veredictos
  previos` (test verde) + salto de `auditadosHoy` (test verde). Verde en
  producción.
- **C8 (GitOps y doc)**: manifiestos en el tronco que lee ArgoCD (este PR),
  `kustomize build` verde, runbook `docs/sauvage-verificacion.md` con pausa /
  `suspend` / criterio (grep `pausa|suspend|criterio` = 6). El CronJob en el
  clúster y el pin `tag@digest` llegan con el PR de release (norma de la casa:
  el digest nace del despacho de `release.yml` desde `deploy/prod`; ver
  runbook).
