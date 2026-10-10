# SKIRM-103 · interruptor `CONNECTOR_SECRET_STRICT` en mcp-sse y los tres conectores de WhatsApp (borrador)

Rol: devops · Fecha: 2026-10-10 · Rama: `SKIRM-103-connector-secret-strict` · Tronco: `deploy/prod` (3cdf251)

## 1. Render del overlay, tronco contra rama (PASS: cuatro altas, una por Deployment)

Comando: `kubectl kustomize k8s/overlays/prod` en el tronco y en la rama, y `diff`. Comprobado con un parseo del render: la variable
`CONNECTOR_SECRET_STRICT=true` aparece solo en los contenedores `mcp-sse`, `whatsapp-connector`, `whatsapp-connector-leila` y
`whatsapp-connector-professional`; `mcp-server`, `social-api`, `whatsapp-pairing`, Telegram, Instagram y los CronJobs no la llevan.

```
710a711,712      (Deployment mcp-sse)
>         - name: CONNECTOR_SECRET_STRICT
>           value: "true"
1346a1349,1350   (Deployment whatsapp-connector)
1465a1470,1471   (Deployment whatsapp-connector-leila)
1592a1599,1600   (Deployment whatsapp-connector-professional)
   (las tres últimas, el mismo par de líneas)
```

## 2. Diff contra el clúster, solo lectura (PASS)

Comando: `kubectl diff -k k8s/overlays/prod` (nada aplicado). Cambian los cuatro Deployments citados (la variable nueva) y aparece el Job de hook
`whatsapp-mcp-migrate` (PreSync de ArgoCD, que se borra al acabar). Ningún otro objeto.

## 3. Comprobaciones del repositorio (PASS)

`kubectl kustomize k8s/overlays/prod` rc 0. Nada del generado cambia (`scripts/render-connectors.py --check` no se ve afectado: el parche vive en el overlay).

## 4. Criterios

- C11: el interruptor que hace que el proceso no arranque con el valor por defecto queda declarado por Deployment en `k8s/overlays/prod`, nunca en `base/`.
- C15: el interruptor va aparte de los pines y solo se fusiona en la ventana de rotación (la PR es un borrador).
