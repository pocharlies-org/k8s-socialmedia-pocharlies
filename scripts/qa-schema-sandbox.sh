#!/usr/bin/env bash
# SKIRM-89: sandbox de esquema de whatsappmcp para probar migraciones contra el
# esquema REAL de producción, en el x86 y sin tocar la BD de producción.
#
# Por qué un sandbox de volcado y no `migrate.ts` sobre BD vacía: el repo NO puede
# recrear producción desde cero — 001_initial_schema.sql crea conversations.id UUID
# pero en producción la columna es text (BD migrada a mano antes del ledger
# _migrations). La 008 aborta sobre el 001-del-repo por eso. Ver
# docs/qa-schema-sandbox.md.
#
# Uso (desde la raíz del repo, en el x86):
#   scripts/qa-schema-sandbox.sh up      volcado de esquema y ledger de prod + Postgres
#                                        desechable + restauración + migraciones
#                                        del repo (el ledger salta lo ya aplicado)
#   scripts/qa-schema-sandbox.sh test    up + una migración de prueba (índice
#                                        único sobre messages) aplicada encima
#   scripts/qa-schema-sandbox.sh down    tira el contenedor y borra los volcados
#
# Opciones por entorno:
#   SANDBOX_NAME   nombre del contenedor docker (default: qa-schema-whatsappmcp;
#                  debe empezar por qa-schema- o skirm89-)
#   PG_IMAGE       imagen Postgres desechable (default: pgvector/pgvector:pg16;
#                  el runner necesita la extensión vector)
#   EXTRA_MIGRATIONS_DIR  directorio con *.sql extra que se aplican junto a las
#                  del repo (para pruebas; no se escriben en el repo)
#   KUBE_POD       pod de Postgres del que se vuelca (default: el que sirve el
#                  Service postgres-shared-rw, por su selector: el clúster CNPG
#                  y los nombres de pod rotan)
#   SANDBOX_DATA   1 = copia también los DATOS de producción (todas las tablas
#                  salvo el ledger, que va aparte) antes de migrar (SKIRM-261:
#                  una migración puede pasar con el esquema y fallar con los datos)
#   EMBEDDING_DIMENSION  la misma que el Job whatsapp-mcp-migrate (default 1024),
#                  para que el runner configure los embeddings como en prod
#
# Seguridad: por defecto las únicas lecturas de producción son `pg_dump
# --schema-only` y `pg_dump --data-only -t _migrations` (solo nombres de fichero,
# fechas y flag; ningún dato de mensajes). Con SANDBOX_DATA=1 se leen también los
# datos (mensajes incluidos): COPY por trozos de prod directamente al psql del
# sandbox, sin fichero en disco; viven solo en ese contenedor del x86 hasta `down`. Los
# volcados de esquema viven en /tmp del x86 y se borran al terminar. El Postgres
# del sandbox se publica solo en 127.0.0.1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/mcp-server/src/infrastructure/database/migrations"
SANDBOX_NAME="${SANDBOX_NAME:-qa-schema-whatsappmcp}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
DUMP_FILE="/tmp/${SANDBOX_NAME}.sql"
LEDGER_FILE="/tmp/${SANDBOX_NAME}-ledger.sql"
STAGE_DIR="/tmp/${SANDBOX_NAME}-migrations"
KUBE_NS=databases
KUBE_POD="${KUBE_POD:-}"
PROD_DB=whatsappmcp
SANDBOX_DATA="${SANDBOX_DATA:-0}"
export EMBEDDING_DIMENSION="${EMBEDDING_DIMENSION:-1024}"

case "$SANDBOX_NAME" in
  qa-schema-*|skirm89-*) ;;
  *) echo "SANDBOX_NAME debe empezar por 'qa-schema-' o 'skirm89-' (es $SANDBOX_NAME)" >&2; exit 1 ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "falta $1 en el PATH" >&2; exit 1; }
}

# Lectura de producción (solo pg_dump). PG17 emite `SET transaction_timeout = 0;`,
# que PG16 (imagen del sandbox) no conoce: se filtra.
prod_pod() {
  if [[ -z "$KUBE_POD" ]]; then
    # El DATABASE_URL de la app apunta a postgres-shared-rw: su selector es el
    # primario vigente, se llame como se llame el clúster CNPG detrás.
    local selector
    selector=$(kubectl -n "$KUBE_NS" get svc postgres-shared-rw -o go-template \
      --template='{{range $k, $v := .spec.selector}}{{$k}}={{$v}},{{end}}')
    KUBE_POD=$(kubectl -n "$KUBE_NS" get pod -l "${selector%,}" \
      -o jsonpath='{.items[0].metadata.name}')
  fi
  [[ -n "$KUBE_POD" ]] || { echo "no se encontró el pod de postgres-shared-rw en $KUBE_NS" >&2; exit 1; }
}

prod_dump() {
  kubectl -n "$KUBE_NS" exec "$KUBE_POD" -c postgres -- \
    pg_dump -U postgres -d "$PROD_DB" "$@" \
    | sed '/^SET transaction_timeout = 0;$/d'
}

prod_psql() {
  kubectl -n "$KUBE_NS" exec "$KUBE_POD" -c postgres -- \
    psql -U postgres -d "$PROD_DB" -At -v ON_ERROR_STOP=1 -c "$1"
}

# SANDBOX_DATA=1: copia cada tabla de public (salvo el ledger) en trozos de
# unos DATA_CHUNK_MB megas (el stream de `kubectl exec` muere a los ~70 s: medido
# 23-10), calculados por tabla con su tamaño real, TOAST incluido; columnas
# generadas fuera (COPY no las acepta). Un stream cortado puede dejar un COPY a
# medias sin error, así que el reintento es de la tabla entera, vaciándola antes.
DATA_CHUNK_MB="${DATA_CHUNK_MB:-40}"
copy_table() {
  local t=$1 pages=$2 step=$3 cols=$4 from to
  for (( from = 0; from <= pages; from += step )); do
    to=$(( from + step ))
    # Primero a un fichero del contenedor y después COPY desde él: cargar en la
    # misma tubería (índices GIN de messages) frena el stream y la API lo corta.
    prod_psql "COPY (SELECT $cols FROM public.\"$t\" WHERE ctid >= '($from,0)'::tid AND ctid < '($to,0)'::tid) TO STDOUT" \
      | docker exec -i -u postgres "$SANDBOX_NAME" sh -c 'umask 077; cat > /tmp/sandbox-chunk' \
      || return 1
    sandbox_psql -q -c 'SET session_replication_role = replica' \
      -c "COPY public.\"$t\" ($cols) FROM '/tmp/sandbox-chunk'" >/dev/null 2>&1 || return 1
  done
  docker exec "$SANDBOX_NAME" rm -f /tmp/sandbox-chunk
}
copy_data() {
  local t pages step cols try total=0
  while read -r t pages step; do
    [[ -n "$t" ]] || continue
    cols=$(prod_psql "SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) FROM pg_attribute
      WHERE attrelid = 'public.$t'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''")
    for try in 1 2 3; do
      copy_table "$t" "$pages" "$step" "$cols" && break
      (( try < 3 )) || { echo "   la copia de $t falló tres veces" >&2; exit 1; }
      echo "   reintento $t (intento $(( try + 1 )))" >&2
      sandbox_psql -q -c "SET session_replication_role = replica" -c "DELETE FROM public.\"$t\"" >/dev/null
    done
    total=$(( total + 1 ))
  done < <(prod_psql "SELECT c.relname || ' ' || pages || ' ' ||
        greatest(1, (pages * $DATA_CHUNK_MB * 1048576 / greatest(pg_table_size(c.oid), 1))::bigint)
      FROM pg_class c
      CROSS JOIN LATERAL (SELECT pg_relation_size(c.oid) / current_setting('block_size')::int AS pages) p JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_migrations' ORDER BY 1")
  # Las secuencias, con el valor de prod (los COPY no las mueven).
  prod_psql "SELECT format('SELECT setval(%L, %s, %s);', schemaname || '.' || sequencename, last_value, 'true')
      FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL" \
    | docker exec -i "$SANDBOX_NAME" psql -U postgres -d "$PROD_DB" -q -v ON_ERROR_STOP=1 >/dev/null
  echo "   $total tablas copiadas"
}

# Puerto publicado en loopback. Con `-p 127.0.0.1::5432` docker devuelve
# "127.0.0.1:NNNN"; cualquier otra salida (otra interfaz) da cadena vacía y el
# script se niega a seguir.
sandbox_port() {
  docker port "$SANDBOX_NAME" 5432/tcp 2>/dev/null | head -1 \
    | sed -n 's/^127\.0\.0\.1:\([0-9]\{1,5\}\)$/\1/p'
}

sandbox_psql() {
  docker exec "$SANDBOX_NAME" psql -U postgres -d "$PROD_DB" -v ON_ERROR_STOP=1 "$@"
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if docker exec "$SANDBOX_NAME" pg_isready -U postgres -d "$PROD_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "el contenedor $SANDBOX_NAME no quedó listo a tiempo" >&2
  docker logs --tail 30 "$SANDBOX_NAME" >&2 || true
  return 1
}

do_down() {
  docker rm -f "$SANDBOX_NAME" >/dev/null 2>&1 || true
  rm -f "$DUMP_FILE" "$LEDGER_FILE"
  rm -rf "$STAGE_DIR"
  echo "sandbox $SANDBOX_NAME retirado; volcados de /tmp borrados"
}

do_up() {
  require docker
  require kubectl
  require npx
  [[ -d "$REPO_ROOT/node_modules/pg" ]] || { echo "ejecuta npm ci en el repo primero (falta node_modules/pg)" >&2; exit 1; }

  # 1. Esquema y ledger de producción (solo lectura, sin salir del x86).
  #    Si el sandbox ya tiene el esquema restaurado, se omite volcado+restauración.
  if docker ps --format '{{.Names}}' | grep -qx "$SANDBOX_NAME" \
     && docker exec "$SANDBOX_NAME" psql -U postgres -d "$PROD_DB" -At \
          -c "SELECT to_regclass('public.conversations')" 2>/dev/null | grep -q conversations; then
    echo "== el sandbox ya tiene el esquema restaurado: se omite volcado y restauración =="
    wait_ready
    local port0
    port0=$(sandbox_port)
    [[ -n "$port0" ]] || { echo "el sandbox no publica su puerto en 127.0.0.1" >&2; exit 1; }
    echo "== aplicando migraciones del repo con migrate.ts =="
    DATABASE_URL="postgres://postgres@127.0.0.1:$port0/$PROD_DB" \
      npx tsx "$REPO_ROOT/scripts/qa-schema-migrate.ts"
    echo "sandbox ya estaba arriba: scripts/qa-schema-sandbox.sh down para tirarlo"
    return 0
  fi
  prod_pod
  echo "== volcando esquema de producción ($KUBE_NS/$KUBE_POD, bd $PROD_DB) =="
  prod_dump --schema-only --no-owner --no-privileges > "$DUMP_FILE"
  echo "   $(wc -c < "$DUMP_FILE") bytes de esquema en $DUMP_FILE"
  # Ledger: sin él el runner re-ejecutaría las migraciones que prod ya tiene aplicadas.
  prod_dump --data-only -t _migrations > "$LEDGER_FILE"
  echo "   $(grep -c '^[0-9][0-9][0-9]_.*\.sql' "$LEDGER_FILE" || true) filas de ledger en $LEDGER_FILE"

  # 2. Postgres desechable, publicado solo en loopback con puerto aleatorio
  if docker ps --format '{{.Names}}' | grep -qx "$SANDBOX_NAME"; then
    echo "== reutilizando contenedor $SANDBOX_NAME ya levantado =="
  else
    docker rm -f "$SANDBOX_NAME" >/dev/null 2>&1 || true
    echo "== levantando $SANDBOX_NAME ($PG_IMAGE) =="
    docker run -d --name "$SANDBOX_NAME" \
      -e POSTGRES_HOST_AUTH_METHOD=trust \
      -e POSTGRES_DB="$PROD_DB" \
      -p 127.0.0.1::5432 "$PG_IMAGE" >/dev/null
  fi
  wait_ready
  local port
  port=$(sandbox_port)
  [[ -n "$port" ]] || { echo "no se encontró el puerto loopback del sandbox (127.0.0.1)" >&2; exit 1; }
  echo "   listo en 127.0.0.1:$port"

  # 3. Restaurar esquema y ledger (la imagen arranca con la bd POSTGRES_DB vacía)
  echo "== restaurando esquema y ledger en el sandbox =="
  docker cp "$DUMP_FILE" "$SANDBOX_NAME:/tmp/sandbox-dump.sql"
  sandbox_psql -q -f /tmp/sandbox-dump.sql
  docker cp "$LEDGER_FILE" "$SANDBOX_NAME:/tmp/sandbox-ledger.sql"
  sandbox_psql -q -f /tmp/sandbox-ledger.sql
  rm -f "$DUMP_FILE" "$LEDGER_FILE"
  docker exec "$SANDBOX_NAME" rm -f /tmp/sandbox-dump.sql /tmp/sandbox-ledger.sql

  # 3b. Datos (SANDBOX_DATA=1), tabla a tabla y en trozos por rango de páginas
  #     (ctid): un único `pg_dump` de ~3,6 GB por `kubectl exec` lo corta la API
  #     con i/o timeout (medido dos veces el 23-10, también con la restauración
  #     fuera de la tubería). Cada trozo es un COPY atómico y se reintenta entero.
  #     session_replication_role=replica: ni FKs ni triggers de prod al cargar.
  if [[ "$SANDBOX_DATA" == "1" ]]; then
    echo "== copiando los datos de producción al sandbox, por trozos (puede tardar) =="
    copy_data
    echo "   participants: $(sandbox_psql -At -c 'SELECT count(*) FROM participants') filas · messages: $(sandbox_psql -At -c 'SELECT count(*) FROM messages') filas"
  fi

  # 4. Migraciones del repo con el runner real: el ledger salta lo aplicado en prod;
  #    cualquier migración nueva corre de verdad.
  echo "== aplicando migraciones del repo con migrate.ts =="
  DATABASE_URL="postgres://postgres@127.0.0.1:$port/$PROD_DB" \
    npx tsx "$REPO_ROOT/scripts/qa-schema-migrate.ts"

  # 5. Verificación mínima del esquema restaurado
  echo "== verificación =="
  local tables id_type ledger
  tables=$(sandbox_psql -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
  id_type=$(sandbox_psql -At -c "SELECT atttypid::regtype FROM pg_attribute WHERE attrelid='conversations'::regclass AND attname='id'")
  ledger=$(sandbox_psql -At -c "SELECT count(*) FROM _migrations")
  echo "   tablas en public: $tables (producción: ~39)"
  echo "   conversations.id: $id_type (debe ser 'text', no 'uuid')"
  echo "   filas en _migrations: $ledger"
  if [[ "$SANDBOX_DATA" == "1" ]]; then
    # Segunda pasada: con todo aplicado no debe ejecutar nada.
    local before after
    before=$(sandbox_psql -At -c "SELECT count(*) FROM schema_migrations")
    DATABASE_URL="postgres://postgres@127.0.0.1:$port/$PROD_DB" \
      npx tsx "$REPO_ROOT/scripts/qa-schema-migrate.ts" | grep -E 'Applied|Adopted' && { echo "   la segunda pasada aplicó algo" >&2; exit 1; }
    after=$(sandbox_psql -At -c "SELECT count(*) FROM schema_migrations")
    echo "   segunda pasada sin cambios: schema_migrations $before -> $after"
    [[ "$before" == "$after" ]] || exit 1
  fi
  [[ "$id_type" == "text" ]] || { echo "   ESQUEMA INCORRECTO: conversations.id=$id_type" >&2; exit 1; }
  echo "sandbox arriba: docker exec -it $SANDBOX_NAME psql -U postgres -d $PROD_DB"
}

do_test() {
  do_up
  echo "== migración de prueba (índice único sobre messages) =="
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp "$MIGRATIONS_DIR"/*.sql "$STAGE_DIR"/
  if [[ -n "${EXTRA_MIGRATIONS_DIR:-}" ]]; then
    cp "$EXTRA_MIGRATIONS_DIR"/*.sql "$STAGE_DIR"/
  fi
  cat > "$STAGE_DIR/999_qa_sandbox_test.sql" <<'SQL'
-- SKIRM-89: prueba de que una migración NUEVA corre de verdad sobre el
-- esquema real restaurado (el ledger baselina 001-020, esta no existe aún).
CREATE UNIQUE INDEX qa_sandbox_messages_unique_id ON messages (id);
SQL
  local port
  port=$(sandbox_port)
  QA_SANDBOX_MIGRATIONS_DIR="$STAGE_DIR" \
  DATABASE_URL="postgres://postgres@127.0.0.1:$port/$PROD_DB" \
    npx tsx "$REPO_ROOT/scripts/qa-schema-migrate.ts"
  sandbox_psql -At -c "SELECT 'qa_sandbox_messages_unique_id' FROM pg_indexes WHERE tablename='messages' AND indexname='qa_sandbox_messages_unique_id'" | grep -q . \
    && echo "   índice de prueba aplicado OK" \
    || { echo "   FALLO: el índice de prueba no existe" >&2; exit 1; }
  echo "prueba completada; deja el sandbox o ejecuta: scripts/qa-schema-sandbox.sh down"
}

case "${1:-up}" in
  up) do_up ;;
  test) do_test ;;
  down) do_down ;;
  *) echo "uso: $0 {up|test|down}" >&2; exit 1 ;;
esac
