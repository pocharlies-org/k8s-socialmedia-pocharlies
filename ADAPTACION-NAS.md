# Revision de adaptacion al NAS

Fecha: 2026-09-12. Revision de codigo y despliegue; no se modifica el runtime.

## Objetivo

Dos cuentas WhatsApp y una Instagram inicialmente. Admitir N cuentas mediante
configuracion, sin nombres de personas o negocios en la logica. Mantener Docker
Compose en `/volume2/docker/social-media` y el codigo en
`/home/staticduo/git/socialmedia`.

## Repositorio y estado real

- Este clon conserva `nas-local` en `2377c7a`, incluidos los parches del despliegue.
- Remoto `upstream`: https://github.com/pocharlies-org/k8s-socialmedia-pocharlies.git.
- Remoto `deployed`: `/volume2/docker/social-media/src`, referencia local del despliegue.
- El clon anterior `/home/staticduo/git/social-media` se conserva: tiene siete
  Dockerfiles modificados sin commit. No se han descartado ni incorporado a ciegas.
- Compose sigue construyendo desde `./src`; crear este clon no cambia las imagenes
  activas. La futura adaptacion debe apuntar los builds al repositorio canonico.
- Siete servicios se anuncian healthy, pero la base contiene cero mensajes y cero
  conversaciones. No hay evidencia de ingesta real correcta.
- `dgx-infra` (dashboard de Daniel) es otro repositorio, privado, rama `master`;
  no esta instalado. `ss.staticduo.com` sirve MCP, no ese dashboard.

## Bloqueantes y cambios necesarios

### P1: esquema incompatible con los escritores

`connectors/whatsapp-web/src/db-writer.ts:479` inserta IDs de texto y columnas
`is_group` y `participant_count`. La tabla viva `conversations` tiene ID UUID y
carece de esas columnas. `participants` presenta el mismo desfase. Instagram
tambien espera el esquema evolucionado. Quitar FKs no corrige esta incompatibilidad.

Definir un esquema coherente y una migracion transaccional que preserve datos y
referencias. Revisar todos los escritores, lectores y embeddings contra el mismo
esquema. Revalidar conteos y respaldo justo antes de migrar; no borrar volumenes.

### P1: aislamiento de cuentas

`mcp-server/src/domain/account.ts:15` convierte cuentas desconocidas en personal.
`mcp-server/src/application/instagram-ingestion.service.ts:96` no incluye cuenta en
el ID del participante; su upsert puede reasignarlo a otra cuenta. En linea 162,
skirmshop se convierte en professional y cualquier otra cuenta en personal.

Validar IDs contra un registro; rechazar desconocidos y desactivados. Separar IDs
de mensajes, conversaciones, participantes, adjuntos y caches por canal/cuenta.
Conservar compatibilidad explicita con claves historicas, sin reinterpretar los
dos puntos que contienen algunos JID nativos de WhatsApp.

### P1: proteger historial, emparejamiento y secretos

`connectors/whatsapp-web/src/main.ts:248` y `:265` exponen chats e historial sin
autenticacion; el proxy del conector puede alcanzarlos. La pagina QR responde 200
sin credenciales. Proteger estas rutas antes del emparejamiento y cerrar el acceso
directo al puerto 3001. Mantener autenticacion Bearer para MCP.

La inspeccion actual muestra `.env` modo 0670 con ACLs de lectura adicionales y
`certs/ca.key` modo 0775 con lectura para otros. Aplicar permisos minimos por
archivo y UID; la CA privada no debe ser legible por servicios que solo necesitan
certificados publicos. Verificar alcance de la clave LiteLLM y usar una clave de
aplicacion limitada. Revisar tambien el incidente previo de claves en Git: no
considerar suficiente que ya no aparezcan en el ultimo arbol.

### P2: registro unico y rutas dinamicas

`mcp-server/src/mcp/server.ts:396`, `:995`, `:1098` y `:4499` fijan endpoints,
catalogo y comprobaciones a personal/professional/skirmshop/barbelpapis.
Las politicas de envio (`:2927`, `:3012`, `:4171`) tambien dependen del nombre.

Un registro debe declarar canal, ID, etiqueta, endpoint, estado, capacidades,
URL de emparejamiento y politica de envio. Catalogo, rutas, comprobaciones y filtros
deben derivarse de el. Las politicas son atributos, no nombres especiales.
Eliminar las URLs de QR de e-dani y exigir configuracion explicita para trabajos
opcionales de Brain/backfill.

### P2: Compose incompleto para varias cuentas

El Compose actual define un solo conector WhatsApp. Crear una instancia por
cuenta con sesion, secreto e identificador independientes; generar servicios y
rutas desde la configuracion para anadir cuentas sin editar codigo.

Instagram ya admite `INSTAGRAM_ACCOUNTS`, pero el Compose no transmite tokens ni
business IDs por cuenta. Disenar inyeccion de secretos separada del registro.
La cuenta Instagram requiere credenciales/permisos Meta apropiados; preparar la
entrada no equivale a conectarla.

Retirar publicaciones innecesarias de NATS 4223/8223 y MinIO 9000/9001; estan
publicadas en todas las interfaces, pese a la descripcion anterior del stack.

### P2: migraciones y reproducibilidad

El servicio migrate solo comprueba si existe `messages`; puede omitir migraciones
nuevas o aceptar un esquema parcial. Sustituirlo por historial versionado,
transacciones y bloqueo de concurrencia. Evitar que errores de conexion se
interpreten como necesidad de inicializar.

Fijar imagenes, guardar configuracion sin secretos y documentar fuente/version
real. Mantener sesiones y datos fuera del checkout de codigo. No copiar sesiones
de wacli: el conector usa Baileys y requiere emparejamiento independiente.

## Orden propuesto

1. Proteger accesos y secretos; tomar respaldo e inventario del esquema.
2. Corregir esquema y migrador; verificar ingesta y lectura con datos sinteticos.
3. Implementar registro, namespaces, rutas y politicas por cuenta.
4. Generar Compose para dos WhatsApp y una Instagram, con secretos separados.
5. Validar en stack aislado y desplegar solo los servicios afectados.
6. Vincular cada WhatsApp y autorizar Instagram; comprobar ingesta real.

## Criterios de aceptacion

- Dos WhatsApp con el mismo chat y message ID no colisionan.
- Una tercera cuenta con nombre arbitrario funciona cambiando solo configuracion.
- Dos Instagram con el mismo remitente mantienen participantes independientes.
- Una cuenta desconocida/desactivada falla y nunca cae en personal.
- Catalogo solo muestra las cuentas declaradas y su estado real.
- Ingesta, lectura, busqueda y adjuntos conservan canal/cuenta.
- Reiniciar o repetir migraciones conserva datos y aplica solo pendientes.
- Acceso anonimo a historial y administracion denegado.
- Pruebas de envio usan mocks; enviar mensajes reales requiere peticion explicita.

Referencias oficiales de consulta:
- https://baileys.wiki/docs/intro/
- https://docs.docker.com/compose/how-tos/profiles/
