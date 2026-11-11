# Sandbox de esquema de whatsappmcp (SKIRM-89)

Herramienta para probar **migraciones de `whatsappmcp` contra el esquema real de
producción** sin tocar la BD de producción y sin sacar datos del clúster.

## Por qué hace falta (el porqué de la 008)

`migrate.ts` sobre una BD vacía **no reproduce el esquema de producción**:
`001_initial_schema.sql` crea `conversations.id UUID`, pero en producción esa
columna es `text` — la BD se migró a mano antes de que existiera el ledger
`_migrations`, y en el ledger la 001 está registrada con `baseline = t`. Por eso
la 008 (`ALTER TABLE conversations ADD COLUMN merged_into TEXT REFERENCES
conversations(id)`) aborta sobre el 001-del-repo con

```
foreign key constraint "conversations_merged_into_fkey" cannot be implemented
Key columns "merged_into" and "id" are of incompatible types: text and uuid
```

El repo **no puede recrear producción desde cero**; la única forma fiel de probar
una migración nueva es partir del esquema real. El sandbox hace exactamente eso:
vuelca el esquema de producción y su ledger, lo restaura en un Postgres desechable
y aplica las migraciones del repo con el runner real. El ledger salta lo que prod
ya tiene aplicado y cualquier migración nueva corre de verdad. (Diagnóstico
completo: `nota-it-informe.md` en SKIRM-89, anexo.)

## Uso (en el x86, desde la raíz del repo, con `npm ci` hecho)

```bash
scripts/qa-schema-sandbox.sh up      # volcado de esquema y ledger + restauración + migraciones del repo
scripts/qa-schema-sandbox.sh test    # up + migración de prueba (índice único en messages)
scripts/qa-schema-sandbox.sh down    # tira el contenedor y borra los volcados de /tmp
```

Dentro del sandbox (solo escucha en loopback):

```bash
docker exec -it qa-schema-whatsappmcp psql -U postgres -d whatsappmcp
```

Para probar una migración concreta, colócala en un directorio propio y:

```bash
EXTRA_MIGRATIONS_DIR=/tmp/mis-migraciones scripts/qa-schema-sandbox.sh test
```

El runner de prueba deja el sandbox levantado; al terminar, siempre `down`.

### Prueba negativa: una migración rota tiene que parar `test`

```bash
mkdir -p /tmp/neg && printf 'SELECT * FROM tabla_que_no_existe;\n' > /tmp/neg/998_rota.sql
EXTRA_MIGRATIONS_DIR=/tmp/neg scripts/qa-schema-sandbox.sh test; echo EXIT=$?
# → sandbox: migración fallida: Error: Migration 998_rota.sql failed: relation "tabla_que_no_existe" does not exist
# → EXIT=1
```

Medida el 08-10 en el x86: `EXIT=1`. La migración fallida no queda en el ledger del
sandbox (el runner la revierte). Cada `test` vacía el staging de `/tmp`, así que la
migración rota no se arrastra a la siguiente ejecución. Al terminar, `down`.

## Qué hace exactamente

1. Lecturas de producción, solo `pg_dump` vía `kubectl -n databases exec <pod de postgres-shared-rw>` (descubierto por el selector del Service `postgres-shared-rw`, el mismo host del `DATABASE_URL` de la app: el clúster CNPG detrás cambia de nombre, p. ej. `postgres-shared-nvme`; `KUBE_POD` lo fija):
   - `--schema-only --no-owner --no-privileges` → `/tmp/qa-schema-whatsappmcp.sql`
     (esquema puro, ~88 KB);
   - `--data-only -t _migrations` → `/tmp/qa-schema-whatsappmcp-ledger.sql`: las 20
     filas del ledger (nombre de fichero, fecha y flag `baseline`), ningún dato de
     mensajes. Sin él el runner re-ejecutaría 002, 005, 012, 014, 015 y 017, que prod
     ya tiene aplicadas.
     Los volcados no salen del x86 y se borran al terminar.
2. Levanta `pgvector/pgvector:pg16` como contenedor desechable (prefijo de nombre
   `qa-schema-`/`skirm89-`). Se publica con `-p 127.0.0.1::5432`: puerto aleatorio
   **solo en loopback**. Si `docker port` no devuelve `127.0.0.1:NNNN`, el script se
   niega a seguir. La imagen lleva la extensión `vector`, que usa el runner.
3. Restaura el esquema y, después, el ledger. Aplica las migraciones del repo con
   `migrate.ts` a través de `scripts/qa-schema-migrate.ts` (wrapper que solo fija la
   BD y, para `test`, un directorio de staging; el runner y el repo no se tocan).
4. Verifica el resultado: tablas en `public` (~39, como en producción), filas en
   `_migrations` (20 tras `up`) y `conversations.id` de tipo `text` (si saliera
   `uuid`, el esquema restaurado es falso y el script falla).

### Con los datos de producción (`SANDBOX_DATA=1`, SKIRM-261)

Una migración puede pasar contra el esquema y fallar contra los datos: la 039
pasaba en el sandbox de esquema (SKIRM-257) y en prod abortó con `duplicate key
value violates unique constraint "whatsapp_contacts_compat_materialized_pkey"`
por una sola fila de `participants` mal archivada. Para probar con los datos:

```bash
SANDBOX_DATA=1 scripts/qa-schema-sandbox.sh up
```

Además del esquema y el ledger, copia los datos de todas las tablas de `public`
(salvo el ledger, que va aparte) **tabla a tabla y en trozos** por rango de
páginas (`ctid`) de unos `DATA_CHUNK_MB` megas (40 por defecto, calculados por tabla con su tamaño real, TOAST incluido), con `COPY` de prod
directamente al psql del sandbox y `session_replication_role = replica`; luego
fija las secuencias con el valor de prod. Un único `pg_dump --data-only` de
~3,6 GB por `kubectl exec` lo corta la API con `i/o timeout` (el stream muere
a los ~70 s; medido el 23-10). Cada trozo es atómico y se reintenta entero. Ningún fichero con datos
queda en disco; el contenedor se borra con `down`. Después aplica las migraciones con el
runner real (con `EMBEDDING_DIMENSION=1024`, como el Job `whatsapp-mcp-migrate`)
y hace una **segunda pasada**, que debe no aplicar nada. Tarda varios minutos
(`messages` y `message_embeddings` son ~3,6 GB). Son datos de clientes: solo en
el x86, solo en loopback, y `down` al terminar.

### Sin restos en prod (SKIRM-261, 23-10)

Un stream de `kubectl exec` cortado no mata el `psql` del pod: su backend se
queda en `ClientWrite` escribiendo a nadie, con el `AccessShareLock` de la tabla
puesto. El 23-10 quedaron así cinco `COPY` de este script 1 h 45 min sobre
`messages`; la migración de prod se puso en cola detrás pidiendo su lock y los
INSERT de la ingesta, detrás de ella, ~20 min. Un backend bloqueado escribiendo
al cliente no atiende `statement_timeout`, solo la terminación, así que:

- cada sesión de prod del script se llama `qa-schema-sandbox-<pid>`
  (`application_name`) y lleva `statement_timeout` (`PROD_STATEMENT_TIMEOUT`,
  120 s) e `idle_in_transaction_session_timeout` de 60 s;
- el script termina con `pg_terminate_backend` las suyas al salir (`trap`), tras
  cada trozo que falla y antes de migrar; al empezar, también las de ejecuciones
  anteriores (`qa-schema-sandbox-%`).

Comprobado: con el `kubectl` local muerto, el backend sigue en `ClientWrite`; la
limpieza lo termina.

### Medir duración y locks (`QA_SANDBOX_PROFILE=1`)

```bash
SANDBOX_DATA=1 QA_SANDBOX_PROFILE=1 scripts/qa-schema-sandbox.sh up
```

El runner informa de cuánto tarda cada migración y, por tabla, de la primera
migración que toma un lock que bloquea escrituras (y la que toma
`AccessExclusiveLock`, que bloquea también lecturas), con los milisegundos que
lo tendría hasta el `COMMIT`. El runner aplica **todo en una transacción**: un
lock tomado al principio se mantiene hasta el final.

## Notas

- La producción corre PostgreSQL 17.5 (CNPG `postgres-shared`); el sandbox usa
  pg16 por la imagen pgvector. El volcado de 17 incluye
  `SET transaction_timeout = 0;` (inexistente en 16) y el script lo filtra; por lo
  demás la restauración es compatible. Si alguna vez el volcado de 17 no restaura
  en 16, lanza con `PG_IMAGE=pgvector/pgvector:pg17` (mismo procedimiento).
- Nunca escribas en la BD de producción: la herramienta solo lee (`pg_dump` y `COPY ... TO STDOUT`) y, para no dejar restos, termina sus propias sesiones de lectura.
- El contenedor es efímero: `down` lo borra todo; no hay estado que conservar.
