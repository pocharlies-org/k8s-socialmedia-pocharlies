# Bot de verificación facial del grupo Sauvage (INFRA-745 + INFRA-746 · INFRA-125)

Cada día, a las 06:30 (Europe/Madrid), una sesión de opencode recorre a todos
los miembros del grupo Sauvage verificado (`-1003365295248`), decide con visión
si muestran la cara en su foto de perfil y deja un informe a Dani por mensaje
privado (cuenta personal). La parte B —aviso por DM, expulsión, seguimiento y
readmisión (INFRA-746)— se ejecuta en la misma pasada **detrás de
`SAUVAGE_MODERATION`, que nace `off`**: con la bandera off el bot no escribe a
ningún miembro ni expulsa a nadie; solo informa.

## Cómo se ejecuta

- Planificador: CronJob `sauvage-verificacion-diaria` (ns `whatsapp-mcp`,
  etiqueta `app=sauvage-verificacion`), GitOps desde `k8s/base/sauvage-verificacion.yaml`.
- El job lanza `opencode run` headless con `qwen38-flash-next-uncensored` vía
  LiteLLM (`OPENAI_API_KEY` del pod = clave virtual `socialmedia`, item
  1Password `litellm` campo `SOCIALMEDIA_KEY`). El prompt está en el ConfigMap
  `sauvage-verificacion-prompt`.
- El agente ejecuta los scripts versionados de `sauvage-verificacion/src/`:
  `main-pasada.ts` (barrido + fotos + veredictos), `veredicto.ts` (re-decisión
  de dudosos por la propia sesión), `main-informe.ts` (informe a Dani) y
  `main-moderacion.ts` (parte B, INFRA-746; inerte con `SAUVAGE_MODERATION=off`).
- Con Telegram solo habla por las rutas HTTP del conector: barrido
  `GET /api/v1/chats/:id/participants` y foto `GET /api/v1/peers/:id/photo` por
  `professional`; informe `POST /api/v1/messages/:chatId` por `personal`. Todo
  firmado con `CONNECTOR_SHARED_SECRET`. El bot no abre clientes MTProto
  (lo afirma `sauvage-verificacion/src/sin-mtproto.test.ts`).
- Estado: Postgres `whatsappmcp`, tablas `savage_verdicts` / `savage_actions`
  (migración 042, la aplica el Job PreSync `whatsapp-mcp-migrate`). Cada pasada
  arranca con `estado cargado: N veredictos previos`; si un job muere a mitad,
  la siguiente no empieza de cero (no re-audita a quien ya auditó hoy).
  `savage_actions` es el registro de la moderación (`dm`, `ban`, `unban`,
  `add`, `link`, `confirmado`, `omitido`, `cancelacion`) y la fuente de C3/C4/C7.
- Evidencia de C1 (cada pasada en su propia sesión): la pasada resuelve el `ses_`
  de su sesión de opencode y deja una fila en `savage_pasadas` (cuenta, `sesion_id`,
  `pasada_at`; migración 044). El `ses_` del log del pod se lo lleva
  `savage-pod-reaper` a las 2 h del éxito — la fila de la BD es la prueba estable;
  el grep de logs (`pasada-sesion ses=`) sigue valiendo solo el mismo día.
- Veredictos: `cara | sin_cara | dudoso | no_auditar`. Sin foto visible para la
  cuenta (404) = `dudoso`; un 504 de la foto (corte de 20 s del conector), un
  error del modelo o una salida no parseable = `no_auditar`, **nunca**
  `sin_cara`. El texto bruto de cada veredicto queda en `savage_verdicts.raw_text`.

## Moderación: activación y pausa (INFRA-746)

La parte B vive detrás de `SAUVAGE_MODERATION` (fail-closed, patrón
`ENABLE_OUTBOUND`): **cualquier valor que no sea exactamente `on` no toca a
nadie** — `main-moderacion.ts` loggea `moderacion off: ninguna accion` y
termina sin abrir el conector. En `k8s/base` la bandera sale `off`; no hay
nada que apagar en base.

Con `on`, cada pasada, después del informe:

1. **Aviso y expulsión (C3)**: a cada miembro con veredicto actual `sin_cara`
   que siga dentro se le envía la guía (`/sauvage-prompt/guia-dm.md`, ConfigMap
   `sauvage-verificacion-prompt`) por DM de la cuenta `professional`, con el
   vídeo explicativo como media nueva (`SAUVAGE_GUIA_VIDEO_URL`; el grupo tiene
   `CHAT_FORWARDS_RESTRICTED`, así que nunca se reenvía tal cual) y después se
   le expulsa con `POST /api/v1/chats/:id/ban`. Cada `ban ID=` va precedido de
   su `dm ID=`; una guía por usuario mientras no cumpla (si una pasada muere
   entre el dm y el ban, la siguiente banea sin reenviar la guía). `dudoso` y
   `no_auditar` **nunca** se expulsan.
2. **Seguimiento y readmisión (C4)**: los expulsados se re-auditan cada pasada
   (foto + visión). Si su veredicto pasa a `cara`: `POST /chats/:id/unban` →
   `POST /chats/:id/members`; si el add responde `missing` (la privacidad del
   objetivo lo bloquea) se exporta el enlace con `POST /chats/:id/invite-export`
   y se le manda por DM. La confirmación es **siempre** la lista de
   participantes (`GET /chats/:id/participants`), nunca el retorno del add:
   `confirmado ID=... true` solo si está en la lista.
3. **Anulación manual del dueño (C7)**: prevalece. Si el dueño desbanea o
   readmite a un expulsado a mano, la siguiente pasada emite
   `omitido ID=... motivo=anulacion_manual` y **nunca** repite el ban. Para
   cortarlo de forma explícita y permanente se registra la cancelación:

   ```sql
   INSERT INTO savage_actions (user_id, action, motivo)
   VALUES ('<id>', 'cancelacion', 'dueno');
   ```

**Activación** (paso del operador, tras verificar la cadena dm→ban sobre un
caso controlado): PR a `deploy/prod` que añade
`k8s/overlays/prod/patch-sauvage-moderacion-on.yaml` (patrón
`patch-correo-bridge-on.yaml`) y lo referencia en `patches:` de
`k8s/overlays/prod/kustomization.yaml`:

```yaml
# patch-sauvage-moderacion-on.yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: sauvage-verificacion-diaria, namespace: whatsapp-mcp }
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: sauvage-verificacion
              env:
                - { name: SAUVAGE_MODERATION, value: "on" }
```

**Pausa de la moderación sin rebuild**: el mismo patch a `off` (o quitarlo del
`kustomization.yaml` del overlay) — es config, no imagen; ArgoCD lo aplica en
el siguiente sync. **Corte de emergencia inmediato, sin PR**:
`EMERGENCY_DISABLE_SENDING=true` en el Secret del conector — las tres rutas
nuevas (`chats-ban.v1`, `chats-unban.v1`, `chats-invite-export.v1`) y todos los
envíos responden 403 `disabled_sending` sin tocar Telegram. La pausa de la
pasada entera sigue siendo `suspend`.

Verificación de los criterios (comandos del 00-spec):

```bash
# C3: cada ban con su dm previo (un ID con ban y sin dm es un fallo)
kubectl -n whatsapp-mcp logs -l app=sauvage-verificacion --since=24h \
  | grep -oE '^(dm|ban) ID=[0-9]+' | sort | uniq -c
# C4: cadena de readmisión de un caso real
kubectl -n whatsapp-mcp logs -l app=sauvage-verificacion --since=168h \
  | grep -E '^(unban|add|link|confirmado) ID=<ID>'
# C7: tras una anulación manual, solo omitido motivo=anulacion_manual
kubectl -n whatsapp-mcp logs job/<pasada-siguiente> | grep 'ID=<ID_ANULADO>'
```

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
opencode, `k8s/base/sauvage-verificacion/opencode.json`. La guía del aviso
(`k8s/base/sauvage-verificacion/guia-dm.md`) está en el mismo ConfigMap: se
edita igual, sin rebuild. Cambiar el modelo de visión requiere además que la
clave `socialmedia` de LiteLLM tenga el alias alta (ver abajo).

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
pnpm --filter ./sauvage-verificacion test   # 31 casos: veredicto, informe, estado, firma, sin-MTProto y moderacion (C3/C4/C7)
pnpm --filter ./connectors/telegram test    # rutas de moderacion: 400 antes del gate, 403 disabled_sending, quirks de mtcute
```
