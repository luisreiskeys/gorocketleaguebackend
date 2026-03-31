#!/bin/sh
set -e

# Monta DATABASE_URL a partir dos secrets para o Prisma CLI (db push, migrate, etc.)
if [ -n "$POSTGRES_USER_FILE" ] && [ -n "$POSTGRES_PASSWORD_FILE" ]; then
  export POSTGRES_USER="$(cat "$POSTGRES_USER_FILE" | tr -d '\n\r')"
  export POSTGRES_PASSWORD="$(cat "$POSTGRES_PASSWORD_FILE" | tr -d '\n\r')"
fi
export POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export POSTGRES_DB="${POSTGRES_DB:-appdb}"

if [ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_PASSWORD" ]; then
  # encoding para URL (evitar caracteres especiais na senha)
  _u="$(printf '%s' "$POSTGRES_USER" | sed 's/%/%25/g; s/:/%3A/g; s/@/%40/g')"
  _p="$(printf '%s' "$POSTGRES_PASSWORD" | sed 's/%/%25/g; s/:/%3A/g; s/@/%40/g')"
  export DATABASE_URL="postgresql://${_u}:${_p}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
fi

exec "$@"
