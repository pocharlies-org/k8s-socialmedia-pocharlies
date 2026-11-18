# Validacion del rediseno SocialMedia

Fecha: 2026-09-23. Codigo: apps/whatsapp. Despliegue:
/volume2/docker/social-media, servicio whatsapp-app.

## Referencia y alcance

WhatsApp Web oficial inspeccionado con Agent Jake en Chrome. Se midieron las
proporciones, tipografia, colores y mascara del fondo. No se guardaron chats
privados en fixtures ni se enviaron mensajes reales durante las pruebas.
Las nuevas funciones propuestas quedan en whatsapp-feature-inventory.md.

## Pruebas de codigo y datos

- npm test en apps/whatsapp: 40 pruebas correctas.
- node --check para server.mjs, public/app.js y public/message-render.mjs.
- git diff --check sin errores.
- test/chat-names.postgres.mjs ejecutado contra PostgreSQL con tablas temporales
  dentro de una transaccion revertida: nombres, grupos, remitentes, fechas,
  direccion y aislamiento por cuenta correctos.
- Revision independiente de los arreglos de borradores, grabacion, sesiones,
  reproduccion durante actualizaciones y visor: sin hallazgos restantes en ese alcance.

## Navegador aislado

test/ui-visual.playwright.mjs sirve fixtures sin datos privados e intercepta todos
los endpoints API. Valida escritorio 1440x675 y movil tactil emulado 390x844,
navegacion, ausencia de overflow, cambio de cuenta, borradores, links/XSS,
mensajes y adjuntos, composer, IA, errores de grabacion y modal accesible.
Usa audio WAV y video WebM/VP8 reproducibles: metadata, play, pause, seek y velocidad.
test/message-render.integration.playwright.mjs valida tambien el contrato DOM.

La comprobacion final uso assets extraidos del contenedor desplegado, WAV y
WebM de 8 segundos: al descartar un mensaje anterior y anadir otro, y al editar
un mensaje anterior, audio y video conservaron su nodo, estado de reproduccion
y avance de currentTime. Tambien paso el resto del arnes desktop/mobile.
Evidencia: /volume2/docker/mcp/playwright/output/socialmedia-deployed-final-playback-valid/ui-visual-summary.json.
El WebM corto anterior se descarto para este caso porque rebobinaba incluso
en un control sin cambios de DOM; no se atribuyo ese fallo de fixture a la app.

Los POST de las pruebas son mocks: no prueban envio real a un destinatario ni
se han utilizado para enviar WhatsApps.

## Despliegue y seguridad

- Compose validado; solo whatsapp-app reconstruido y recreado con --no-deps.
- UID:GID 1000:10 preservado; emparejamientos y datos de conectores conservados.
- Los ocho archivos principales y assets fueron comparados por SHA-256 entre
  fuente y contenedor tras el despliegue final.
- Dominio publico: / devuelve 302 al login, /health devuelve 200 y /api/accounts
  y /api/media rechazan acceso sin sesion con 401.
- Se verifico en Chrome el recorrido Keycloak -> Google SSO -> SocialMedia y
  la disponibilidad de ambas cuentas. La conexion de la extension se perdio
  despues, por lo que la comparativa visual de la ultima revision se hace con
  el navegador aislado, no con esa sesion de Chrome.
- App y ambos conectores saludables; ambos conectores reportaron CONNECTED.
- Proxy de media probado contra adjuntos reales de MinIO desde un servidor
  efimero local que usa el mismo codigo, sin alterar la autenticacion productiva:
  audio, imagen, documento y video devolvieron 206, Content-Range valido y 64 bytes
  para bytes=0-63. La reproduccion de codecs se prueba con fixtures sinteticos.

Backup previo de codigo e identificador de imagen:
/volume2/docker/social-media/backups/20260923-075915-before-visual-ui.
