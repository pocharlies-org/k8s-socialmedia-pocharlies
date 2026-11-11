# skirm-129-nombre-documento (SKIRM-129, F4d)

- Antes: `POST /messages/media/send` quitaba los separadores de ruta de `fileName` y pegaba los trozos (`../informe.pdf` → `..informe.pdf`, `a/b.pdf` → `ab.pdf`); sin `fileName`, una URL `data:` daba como nombre lo que sigue al tipo (`pdf;base64,YQ==`).
- Ahora: el nombre es el último segmento de la ruta (`../informe.pdf` → `informe.pdf`, `a/b.pdf` → `b.pdf`), con los caracteres de control quitados y ≤ 200 como antes; una URL `data:` sin `fileName` da `attachment`. La ruta, los campos, el 200 y el 400 `invalid_file_name` no cambian.
- Quién se mueve: nadie. `dgx-messages` (`send-media`) ya manda solo el último segmento y el MCP pasa el `name` del adjunto; un `fileName` con directorios y la misma `Idempotency-Key` de antes del despliegue se vería como otra petición (el hash lleva el nombre ya limpio).
- Decidido en: `00-spec.md` de SKIRM-129 (C3, C6: una corrección dentro de lo que el contrato ya promete es solo nota `migrate`) y la nota del architect de SKIRM-105 (nota 1, `nota-architect-pr243.md`).
