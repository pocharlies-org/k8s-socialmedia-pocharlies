# WhatsApp Web: inventario para SocialMedia

Referencia: WhatsApp Web oficial abierto en Chrome, inspeccionado con Agent Jake
el 2026-09-23. Sin llamadas ni videollamadas. Este inventario no autoriza ni activa
las funciones pendientes. No contiene conversaciones ni datos de contactos.

## Diseno actual

Objetivo: reproducir la disposicion y proporciones observadas, con marca
SocialMedia, selector de cuentas y asistente privado. Referencia escritorio
1440 x 675: barra lateral 64 px, cabeceras 64 px, filas 76 px, avatares 48 px,
texto de mensaje 14.2 px / 19 px. Colores oscuros: fondo #161717, barra #1d1f1f,
entrantes #242626, salientes #144d37. Roboto variable se sirve localmente
desde Fontsource 5.3.0, con licencia en public/fonts/Roboto-LICENSE.txt.
El patron local public/chat-wallpaper.svg procede del recurso de interfaz
https://static.whatsapp.net/rsrc.php/yx/r/voSdkk88H7C.svg, observado en el navegador;
se utiliza como mascara a 412.5 x 749.25 px, sin peticiones externas en runtime.

Las cuentas y los endpoints siguen configurados fuera del frontend. Se conserva
Keycloak, el aislamiento por cuenta y chat, y el envio manual con confirmacion
del proveedor. No se inventan recibos de lectura ni fotos de contactos.

## Funciones para elegir

| ID | Funcion | Evidencia en WhatsApp oficial | Trabajo necesario en SocialMedia |
| --- | --- | --- | --- |
| 1 | Ficha de grupo: descripcion, miembros y administradores | Panel Info. del grupo | Connector ya consulta info y miembros; falta API autenticada del app y panel, resolviendo nombres por cuenta. |
| 2 | Ficha de contacto y fotos reales | Cabecera/perfil y lista de chats | Nombres ya sincronizados; falta proxy seguro de fotos y ficha con los datos disponibles. |
| 3 | Galeria de archivos, enlaces y documentos por chat | Panel de grupo | Adjuntos ya consultables; faltan indices, filtros y paginacion. |
| 4 | Buscar dentro de una conversacion o todo el historial | Buscar de cabecera y buscador de chats | La app filtra chats localmente; MCP tiene busqueda textual/semantica. Falta endpoint y UI de resultados. |
| 5 | Responder citando un mensaje | Capacidad auditada en connector | API soporta replyTo; la cita depende de cache en memoria. Hay que conservar el mensaje original para sobrevivir reinicios. |
| 6 | Reacciones con emoji | Capacidad auditada en connector | Envio disponible; faltan agregacion de reacciones, API app y UI. |
| 7 | Reenviar y seleccionar varios mensajes | Reenviar multimedia y Seleccionar mensajes | Seleccion pendiente. Forward existe nominalmente pero falla por falta del mensaje completo: necesita almacenamiento durable. |
| 8 | Editar o borrar mensajes | Capacidad de la biblioteca instalada | Editar necesita connector. Borrar requiere corregir primero la coherencia entre status e is_deleted. |
| 9 | Archivar, fijar, silenciar y marcar leido/no leido | Filtros/lista y menu de conversacion | Archivo/unread parcialmente persistidos. Faltan mutaciones/UI; lectura actual solo cubre la ultima key conocida. |
| 10 | Favoritos, listas y mensajes destacados | Filtros, menu y panel de grupo | Falta modelo de datos, sincronizacion y UI. |
| 11 | Iniciar chats y gestionar contactos | Buscador y nuevo chat | Hay mecanismos operativos/protecciones de primer envio; falta flujo de usuario con validacion. |
| 12 | Crear y gestionar grupos | Anadir miembro y panel de grupo | Biblioteca soporta operaciones; faltan wrappers, permisos, API y UI. |
| 13 | Selector de emojis, GIF y stickers | Panel con las tres pestanas | Emojis pueden ser locales; stickers/GIF necesitan completar payloads y flujo de envio. |
| 14 | Compartir contactos, encuestas, eventos y camara | Menu Adjuntar | Faltan flujos y APIs; varios tipos necesitan tambien recepcion/render especificos. |
| 15 | Mensajes temporales y privacidad | Menu y panel de grupo, Restringir chat | Biblioteca ofrece parte de la base; no hay wrappers ni persistencia apropiada. |
| 16 | Exportar conversacion | Menu y panel de grupo | Historial disponible para construir exportacion; definir formato y tratamiento de adjuntos. |
| 17 | Notificaciones de escritorio y avisos | Interfaz oficial | App actual consulta cada 10 s; falta notificacion, permisos y politica de privacidad. |
| 18 | Ajustes de sesion y cierre de sesion visible | Revision de la app propia | El backend tiene logout local por POST; falta un flujo visible que distinga salir de SocialMedia de cerrar el SSO de otras apps. |
| 19 | Estados | Seccion visible en la barra lateral oficial | No expuesta en la app. Auditar lectura, publicacion y permisos del connector antes de prometer acciones concretas. |
| 20 | Canales | Seccion visible en la barra lateral oficial | No expuesta en la app; requiere auditar soporte de canales/newsletters y desarrollar sus flujos. |
| 21 | Comunidades | Seccion visible en la barra lateral oficial | No expuesta en la app; requiere modelo y operaciones especificas ademas de los grupos. |
| 22 | Actualizacion en tiempo real y estado escribiendo | Capacidad parcial auditada en connector | La app hace polling cada 10 s; el connector emite presencia al dashboard. Falta canal de eventos autenticado para el navegador. |

Las filas 5, 6 y 8 describen capacidades auditadas, no acciones ejecutadas durante
la inspeccion. Ninguna prueba de esta revision envia mensajes a WhatsApp.

## Limitaciones verificadas

- La app consulta hasta 500 chats y los ultimos 200 mensajes por conversacion;
  mostrar mas historial requiere paginacion y posiblemente backfill adicional.
- Baileys instalado: 7.0.0-rc13. Que la biblioteca admita una operacion no implica
  que el connector, el MCP o la app ya la expongan correctamente.
- El endpoint legacy de history del connector fija fromMe=false; la app utiliza
  la consulta SQL con direction, que preserva la direccion real.
- No exponer metadata completa al navegador: contiene datos internos. Cualquier
  enriquecimiento debe usar campos permitidos y aislamiento por cuenta/chat.
- La IA actual consulta contexto y prepara borradores; sus respuestas no se
  envian automaticamente a WhatsApp.

## Puntos de codigo

- apps/whatsapp/lib/chat-names.mjs: listado y nombres por cuenta, grupos y remitentes.
- apps/whatsapp/server.mjs: autenticacion, API app y proxy de adjuntos.
- connectors/whatsapp-web/src/api/controller.ts: grupos, miembros, media y acciones.
- connectors/whatsapp-web/src/baileys-client.ts: soporte real y limites del proveedor.
- mcp-server/src/application/search.service.ts: busqueda indexada.
- mcp-server/src/infrastructure/database/migrations/008_provider_identity_schema.sql:
  identidad, perfiles y metadatos de mensajes.
