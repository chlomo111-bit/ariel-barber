#!/bin/bash
# Installe un bot (modèle Ariel) sur un serveur Ubuntu 24.04. Usage (en root) :
#   curl -fsSL https://raw.githubusercontent.com/chlomo111-bit/ariel-barber/main/bot/install-server.sh | bash -s ariel
# Ne contient aucun secret : le .env et la session WhatsApp sont copiés ensuite depuis le Mac.
set -e
NAME="${1:-ariel}"
DIR="/opt/bots/$NAME"
export DEBIAN_FRONTEND=noninteractive
echo "== Serveur de bots : installation de « $NAME » dans $DIR =="

apt-get update -qq
apt-get install -y -qq curl ca-certificates tar ufw unattended-upgrades >/dev/null

# Node.js 22 LTS
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# cloudflared (adresse publique du bot)
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i /tmp/cloudflared.deb >/dev/null && rm -f /tmp/cloudflared.deb
fi

# pm2 : garde les bots allumés et les relance au redémarrage du serveur
command -v pm2 >/dev/null || npm install -g pm2 --silent >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# pare-feu : seulement SSH (les bots sortent par cloudflared, aucun port à ouvrir)
ufw allow OpenSSH >/dev/null; ufw --force enable >/dev/null

# fichiers du bot
mkdir -p "$DIR"; cd "$DIR"
BASE=https://raw.githubusercontent.com/chlomo111-bit/ariel-barber/main/bot
for f in bot.js package.json package-lock.json .env.example; do curl -fsSL "$BASE/$f" -o "$f"; done
npm ci --omit=dev --no-audit --no-fund --silent
timedatectl set-timezone Asia/Jerusalem || true

echo ""
echo "✅ Installation terminée : $DIR"
echo "   Node $(node -v) · cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}') · pm2 $(pm2 -v)"
echo "   Étape suivante : copier .env + wa-session depuis le Mac, puis démarrer avec pm2."
