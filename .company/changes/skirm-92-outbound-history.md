Antes: un envío 1:1 sin tctoken ni INBOUND previo, aunque el dueño hubiera escrito antes desde su móvil, daba `403 account_restricted` en `/messages/send`, `/messages/media/send`, `/messages/forward` y el resto de envíos directos.
Ahora: si la conversación canónica (PN o LID, gemelas fusionadas) tiene un OUTBOUND no fallido, el envío sale (`evidence=outbound_history`); el primer contacto real sigue dando el mismo 403. Ruta, cuerpo y forma de las respuestas no cambian.
Quién se mueve: nadie. Los llamadores (MCP `social_*`, Synapse) solo dejan de recibir ese 403 en chats que el dueño ya abrió; `CONTRACTS.yaml` lleva la frase aditiva en `http.whatsapp-connector.messages-forward.v1`.
Decisión: SKIRM-92, `00-spec.md` y `nota-architect-plan.md` (enmienda E1), adjuntos a la Request.
