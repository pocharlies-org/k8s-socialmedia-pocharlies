# telegram-messages-single (SKIRM-101)

- Antes: `GET /api/v1/messages/media/:chatId/:msgId` y `GET /api/v1/peers/:id/photo` del conector Telegram contestaban 500 (la foto, 404 si fallaba la búsqueda del peer o los candidatos) y una descarga colgada no tenía plazo; no había ruta para pedir un mensaje suelto.
- Ahora: `messages/media` corta a los 120 s y `peers/photo` a los 20 s; contestan 504 (plazo), 429 con `Retry-After` (flood wait de Telegram) o 502 (resto, incluido el fallo de la búsqueda del peer que antes era 404); el 200 y el 404 de «sin medio» / «sin foto» no cambian. Ruta nueva `GET /api/v1/messages/single/:chatId/:msgId` (`http.telegram-connector.messages-single.v1`), con los mismos códigos.
- Quién se mueve: nadie está obligado (cambio aditivo sobre el 500); un consumidor que distinga el 500 de otros 5xx debe aceptar 429/502/504, y uno que tratase el fallo de `peers/photo` como 404 lo verá como 502. `telegram-sync` ya lo hace (`retry_after`, `get_message`).
- Decidido en: SKIRM-99, `nota-architect-plan.md` §3.1, `nota-architect-pr229.md` (hallazgo 5) y `00-spec.md` de SKIRM-101 (C6).
