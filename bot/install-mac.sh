#!/bin/bash
# Installation + lancement du bot d'Ariel sur Mac. Usage : bash install-mac.sh
set -e
DIR="${1:-$HOME/Desktop/bot-ariel}"
echo "== Bot Ariel : installation dans $DIR =="
if ! command -v node >/dev/null; then
  echo ""; echo "Node.js n'est pas installé."
  echo "1) Le site nodejs.org va s'ouvrir : télécharge la version LTS et installe-la (double-clic)."
  echo "2) Puis ferme ce Terminal, rouvre-le et recolle la même commande."
  open "https://nodejs.org/"; exit 1
fi
mkdir -p "$DIR"; cd "$DIR"
TMP=$(mktemp -d)
curl -fsSL https://github.com/chlomo111-bit/ariel-barber/archive/refs/heads/main.zip -o "$TMP/a.zip"
unzip -qo "$TMP/a.zip" -d "$TMP"
cp -f "$TMP"/ariel-barber-main/bot/{bot.js,package.json,package-lock.json,start-bot.command,.env.example} .
chmod +x start-bot.command
if ! command -v cloudflared >/dev/null && [ ! -x ./cloudflared ]; then
  echo "Téléchargement de cloudflared…"
  ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && F=cloudflared-darwin-arm64.tgz || F=cloudflared-darwin-amd64.tgz
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/$F" -o "$TMP/cf.tgz"
  tar -xzf "$TMP/cf.tgz" -C . && chmod +x cloudflared
fi
if [ ! -f .env ]; then
  echo ""
  read -r -p "Colle la clé GitHub (github_pat_...) puis Entrée : " TOK
  read -r -p "Numéro WhatsApp du BOT (ex. 0501234567) puis Entrée : " PH
  read -r -s -p "Mot de passe de l'utilisateur bot puis Entrée : " PW; echo
  printf 'GH_TOKEN=%s\nADMIN_USER=bot\nADMIN_PASSWORD=%s\nBOT_PHONE=%s\nPORT=8787\n' "$TOK" "$PW" "$PH" > .env
  chmod 600 .env
fi
echo "Installation des modules…"; npm install --no-audit --no-fund --silent
echo ""; echo "== C'est prêt. Lancement du bot… (laisse cette fenêtre ouverte) =="
export PATH="$DIR:$PATH"
while true; do caffeinate -i node bot.js || true; echo "Le bot s'est arrêté, relance dans 5 s…"; sleep 5; done
