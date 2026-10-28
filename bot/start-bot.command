#!/bin/bash
# לחיצה כפולה מפעילה את הבוט (Mac). החלון צריך להישאר פתוח.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "חסר Node.js. התקן מ-https://nodejs.org (גרסת LTS) והפעל שוב."; read -n1; exit 1; fi
if ! command -v cloudflared >/dev/null; then
  if command -v brew >/dev/null; then brew install cloudflared; else echo "חסר cloudflared. התקן Homebrew מ-https://brew.sh ואז: brew install cloudflared"; read -n1; exit 1; fi
fi
[ -f .env ] || { cp .env.example .env; echo "נוצר קובץ .env. מלא אותו (open -e .env) והפעל שוב."; open -e .env; read -n1; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
while true; do
  caffeinate -i node bot.js
  echo "הבוט נעצר. מפעיל מחדש בעוד 5 שניות…"; sleep 5
done
