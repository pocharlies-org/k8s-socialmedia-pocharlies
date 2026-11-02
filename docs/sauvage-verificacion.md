# Bot de verificación facial del grupo Sauvage (INFRA-745 · INFRA-125 A)

Cada día, a las 06:30 (Europe/Madrid), una sesión de opencode recorre a todos
los miembros del grupo Sauvage verificado (`-1003365295248`), decide con visión
si muestran la cara en su foto de perfil y deja un informe a Dani por mensaje
privado (cuenta personal). **No escribe a ningún miembro y no expulsa a nadie**:
es la mitad sin efectos de la épica; la expulsión (parte B) es INFRA-746 y nace
apagada por bandera.

## Cómo se ejecuta

- Planificador: CronJob `sauvage-verificacion-diaria` (ns `whatsapp-mcp`,
  etiqueta `app=sauvage-verificacion`), GitOps desde `k8s/base/sauvage-verificacion.yaml`.
- El job lanza `opencode run` headless con `qwen38-flash-next-uncensored` vía
  LiteLLM (`OPENAI_API_KEY` del pod = clave virtual `socialmedia`, item
  1Password `litellm` campo `SOCIALMEDIA_KEY`). El prompt está en el ConfigMap
  `sauvage-verificacion-prompt`.
- El agente ejecuta los scripts versionados de `sauvage-verificacion/src/`:
  `main-pasada.ts` (barrido + fotos + veredictos), `veredicto.ts` (re-decisión
  de dudosos por la propia sesión) y `main-informe.ts` (informe a Dani).
- Con Telegram solo habla por las rutas HTTP del conector: barrido
  `GET /api/v1/chats/:id/participants` y foto `GET /api/v1/peers/:id/photo` por
  `professional`; informe `POST /api/v1/messages/:chatId` por `personal`. Todo
  firmado con `CONNECTOR_SHARED_SECRET`. El bot no abre clientes MTProto
  (lo afirma `sauvage-verificacion/src/sin-mtproto.test.ts`).
- Estado: Postgres `whatsappmcp`, tablas `savage_verdicts` / `savage_actions`
  (migración 042, la aplica el Job PreSync `whatsapp-mcp-migrate`). Cada pasada
  arranca con `estado cargado: N veredictos previos`; si un job muere a mitad,
  la siguiente no empieza de cero (no re-audita a quien ya auditó hoy).
- Veredictos: `cara | sin_cara | dudoso | no_auditar`. Sin foto visible para la
  cuenta (404) = `dudoso`; un 504 de la foto (corte de 20 s del conector), un
  error del modelo o una salida no parseable = `no_auditar`, **nunca**
  `sin_cara`. El texto bruto de cada veredicto queda en `savage_verdicts.raw_text`.

## Cómo se pausa

`suspend` es la pausa del operador, por GitOps (nunca `kubectl patch`):

```bash
# editar k8s/base/sauvage-verificacion.yaml -> suspend: true, PR a deploy/prod
```

ArgoCD aplica y el planificador deja de disparar. Los jobs ya terminados se
conservan 7 días (`ttlSecondsAfterFinished`). Reanudar: `suspend: false`.
Corte de emergencia de cualquier envío: `EMERGENCY_DISABLE_SENDING` en el
Secret del conector (el informe sale 403 y nada llega a Telegram).

## Cómo se cambia el criterio

El criterio de visión vive en `k8s/base/sauvage-verificacion/prompt-vision.md`
(ConfigMap de nombre estático, patrón `brain-windows-config`): un PR a
`deploy/prod` lo actualiza y la siguiente pasada lo lee sin rebuild ni
rearranque. El prompt de la pasada completa es
`k8s/base/sauvage-verificacion/prompt-pasada.md`, y el modelo y proveedor de
opencode, `k8s/base/sauvage-verificacion/opencode.json`. Cambiar el modelo de
visión requiere además que la clave `socialmedia` de LiteLLM tenga el alias
alta (ver abajo).

## Destino del informe

Por defecto el informe va al self-chat de la cuenta personal (el bot resuelve
el id propio con `GET /api/v1/me`). `SAUVAGE_REPORT_CHAT_ID` en el manifiesto
fija otro chat si el operador lo prefiere.

## Release y pines (condición de vida del CronJob)

1. Fusionar el código a `deploy/prod`.
2. Despachar `release.yml` desde `deploy/prod` con `image_tag` explícito
   (norma de la casa: nunca sin `image_tag`).
3. En el PR de release, en el bloque `images:` de
   `k8s/overlays/prod/kustomization.yaml`: pin `tag@digest` de
   `whatsappmcp-sauvage-verificacion` **y** avance de `whatsappmcp-mcp-server`
   al build que lleve la migración 042 (es ese bloque, no `patch-image.yaml`,
   el que mueve el Job PreSync; sin el avance el CronJob muere con
   «relation savage_verdicts does not exist»).

## Alta del alias de visión (devops)

La clave `socialmedia` de LiteLLM debe tener el alias
`qwen38-flash-next-uncensored` (item 1Password `litellm`, campo
`SOCIALMEDIA_KEY`). Sin él cada llamada de visión responde 403
`key_model_access_denied` y la pasada termina con todos los miembros en
`no_auditar` (nunca `sin_cara`: el fallo del modelo no es un incumplimiento).
Comprobación:

```bash
curl -s https://litellm.e-dani.com/v1/models -H "Authorization: Bearer $SOCIALMEDIA_KEY"
```

## Pruebas

```bash
pnpm --filter ./sauvage-verificacion test   # 18 casos: veredicto, informe, estado, firma, sin-MTProto
```
