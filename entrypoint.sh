#!/bin/sh
set -e

# Ce script récrit les fichiers secrets à partir de variables d'environnement
# (base64), puis lance le bot. Ça évite de les intégrer à l'image ou au git.

if [ -n "$CREDENTIALS_JSON" ]; then
  echo "$CREDENTIALS_JSON" | base64 -d > /app/credentials.json
  echo "✅ credentials.json écrit"
else
  echo "⚠️ CREDENTIALS_JSON non définie — le bot plantera."
fi

if [ -n "$TOKEN_JSON" ]; then
  echo "$TOKEN_JSON" | base64 -d > /app/token.json
  echo "✅ token.json écrit"
fi

exec node /app/index.js
