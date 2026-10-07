# telegram-messages-single (SKIRM-101)

- Antes: `GET /api/v1/messages/media/:chatId/:msgId` y `GET /api/v1/peers/:id/photo` del conector Telegram contestaban 500 a cualquier fallo y una descarga colgada no tenía plazo; no había ruta para pedir un mensaje suelto.
- Ahora: las mismas rutas cortan a los 120 s y contestan 504 (plazo), 429 con `Retry-After` (flood wait de Telegram) o 502 (resto); el 200 y el 404 no cambian. Ruta nueva `GET /api/v1/messages/single/:chatId/:msgId` (`http.telegram-connector.messages-single.v1`), con los mismos códigos.
- Quién se mueve: nadie está obligado (cambio aditivo sobre el 500); un consumidor que distinga el 500 de otros 5xx debe aceptar 429/502/504. `telegram-sync` ya lo hace (`retry_after`, `get_message`).
- Decidido en: SKIRM-99, `nota-architect-plan.md` §3.1 y `00-spec.md` de SKIRM-101 (C6).
