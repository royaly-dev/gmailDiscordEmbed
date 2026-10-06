# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Image du bot gmailDiscordEmbed
# ---------------------------------------------------------------------------
FROM node:20-slim

# Dossier de travail dans le conteneur
WORKDIR /app

# On installe d'abord les dépendances pour profiter du cache Docker
# (réutilisé tant que package.json / package-lock.json ne changent pas)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# On copie le reste du code source
COPY . .

# Script de démarrage (écrit les secrets puis lance le bot)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Environnement production
ENV NODE_ENV=production

# ---------------------------------------------------------------------------
# ⚠️ SECURITE : credentials.json et token.json NE SONT PAS copiés ici.
# Ils sont recréés au démarrage depuis les variables d'environnement
# CREDENTIALS_JSON et TOKEN_JSON (en base64) — voir entrypoint.sh.
# seen.json est créé/écrit automatiquement par le bot à cet emplacement.
# ---------------------------------------------------------------------------

# Le bot n'est pas un serveur web : aucun EXPOSE nécessaire.
# (Certaines plateformes en exigent un ; alors ajoute "EXPOSE 3000".)

# Démarrage
ENTRYPOINT ["/app/entrypoint.sh"]
