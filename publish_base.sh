#!/usr/bin/env bash
# Выкладывает правила и законы из твоего Trace Helper в общую базу.
# У всех пользователей она подтянется сама в течение часа.
# Копия кладётся и в программу (src-tauri/base.json) — попадёт в следующую сборку.
set -euo pipefail
cd "$(dirname "$0")"

REPO="demidsev3-byte/TraceHelper"
LIB="$APPDATA/com.filosov.helper/library.json"

python - "$LIB" src-tauri/base.json <<'EOF'
import json, sys
src, dst = sys.argv[1:]
docs = json.load(open(src, encoding="utf-8"))["docs"]
docs = [{k: v for k, v in d.items() if k not in ("prevText", "changedAt")} for d in docs if d.get("text", "").strip()]
json.dump({"docs": docs}, open(dst, "w", encoding="utf-8"), ensure_ascii=False)
laws = sum(1 for d in docs if not any(w in (d["section"] + d["title"]).lower() for w in ("правил", "регламент")))
print(f"В базе {len(docs)} документов, из них законов: {laws}")
EOF

# отдельный «предрелиз» base, чтобы не мешать обновлениям программы
if ! gh release view base --repo "$REPO" >/dev/null 2>&1; then
  gh release create base --repo "$REPO" --prerelease --title "База правил и законов" \
    --notes "Общая база Trace Helper. Программа скачивает её сама." >/dev/null
fi
gh release upload base src-tauri/base.json --repo "$REPO" --clobber
echo "Готово: база выложена."
