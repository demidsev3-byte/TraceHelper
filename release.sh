#!/usr/bin/env bash
# Выпуск новой версии Trace Helper.
# 1) подними "version" в src-tauri/tauri.conf.json
# 2) запусти: bash release.sh "что нового"
# Скрипт коммитит изменения и пушит тег. Собирает и выкладывает релиз GitHub Actions
# (.github/workflows/release.yml), за ходом можно следить: gh run watch
set -euo pipefail
cd "$(dirname "$0")"

NOTES="${1:-Обновление}"
VER=$(node -p "require('./src-tauri/tauri.conf.json').version")

if git rev-parse "v$VER" >/dev/null 2>&1; then
  echo "Тег v$VER уже есть — подними версию в tauri.conf.json"; exit 1
fi

git add -A
git commit -m "Trace Helper $VER" -m "$NOTES" || true
git tag -a "v$VER" -m "$NOTES"
git push origin HEAD "v$VER"
echo "Тег v$VER отправлен. Сборка идёт в GitHub Actions: gh run watch"
