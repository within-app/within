#!/bin/sh
# Füllt Geheimnisse aus dem Secrets-Volume nach, die nicht als Umgebungs-
# variable gesetzt sind, und startet dann den eigentlichen Befehl.
#
# Der init-Dienst der Compose-Datei erzeugt beim ersten Start einmalig
#   $SECRETS_DIR/db_password     (auch von Postgres über POSTGRES_PASSWORD_FILE gelesen)
#   $SECRETS_DIR/session_secret  (Signierschlüssel für Sitzungs-Cookies)
# Explizit gesetzte Variablen (DATABASE_URL, SESSION_SECRET) haben Vorrang —
# bestehende Installationen mit eigener .env laufen unverändert.
set -eu

SECRETS_DIR="${WITHIN_SECRETS_DIR:-/run/within-secrets}"
DB_HOST="${WITHIN_DB_HOST:-db}"
DB_NAME="${WITHIN_DB_NAME:-journal}"
DB_USER="${WITHIN_DB_USER:-journal}"

if [ -z "${SESSION_SECRET:-}" ] && [ -r "$SECRETS_DIR/session_secret" ]; then
  SESSION_SECRET="$(cat "$SECRETS_DIR/session_secret")"
  export SESSION_SECRET
fi

if [ -z "${DATABASE_URL:-}" ] && [ -r "$SECRETS_DIR/db_password" ]; then
  # Das erzeugte Passwort besteht nur aus A–Z, a–z, 0–9 — keine Kodierung nötig.
  DATABASE_URL="postgresql://${DB_USER}:$(cat "$SECRETS_DIR/db_password")@${DB_HOST}:5432/${DB_NAME}"
  export DATABASE_URL
fi

exec "$@"
