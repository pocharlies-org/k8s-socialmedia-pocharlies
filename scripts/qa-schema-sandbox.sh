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
#
# Seguridad: las únicas lecturas de producción son `pg_dump --schema-only` y
# `pg_dump --data-only -t _migrations` (solo nombres de fichero, fechas y flag;
# ningún dato de mensajes). Los volcados viven en /tmp del x86 y se borran al
# terminar. El Postgres del sandbox se publica solo en 127.0.0.1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/mcp-server/src/infrastructure/database/migrations"
SANDBOX_NAME="${SANDBOX_NAME:-qa-schema-whatsappmcp}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
DUMP_FILE="/tmp/${SANDBOX_NAME}.sql"
LEDGER_FILE="/tmp/${SANDBOX_NAME}-ledger.sql"
STAGE_DIR="/tmp/${SANDBOX_NAME}-migrations"
KUBE_NS=databases
KUBE_POD=postgres-shared-2
PROD_DB=whatsappmcp

case "$SANDBOX_NAME" in
  qa-schema-*|skirm89-*) ;;
  *) echo "SANDBOX_NAME debe empezar por 'qa-schema-' o 'skirm89-' (es $SANDBOX_NAME)" >&2; exit 1 ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "falta $1 en el PATH" >&2; exit 1; }
}

# Lectura de producción (solo pg_dump). PG17 emite `SET transaction_timeout = 0;`,
# que PG16 (imagen del sandbox) no conoce: se filtra.
prod_dump() {
  kubectl -n "$KUBE_NS" exec "$KUBE_POD" -- \
    pg_dump -U postgres -d "$PROD_DB" "$@" \
    | sed '/^SET transaction_timeout = 0;$/d'
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
