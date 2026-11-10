"""Собирает каталог Trace Wiki (снимки страниц из trace-catalog.json) в src-tauri/catalog.json.

Запуск: python tools/parse_catalog.py <trace-catalog.json> [<старый дамп со скинами>]
Снимки делает скрипт в браузере (tools/catalog-dump.js); повторы убираются по ID.
"""
import json
import re
import sys
from pathlib import Path

NB = " "
PRICE = re.compile(r"^[\d" + NB + r" ]+\s*(\$|TC)$")
STATUS = {"Не продаётся", "Эксклюзив"}
CDN = "https://cdn.trace-rp.com/"


def clean(s: str) -> str:
    return s.replace(NB, " ").strip()


def lines(text: str) -> list[str]:
    return [clean(l) for l in text.split("\n") if clean(l)]


def price_num(p: str) -> int | None:
    m = re.match(r"^([\d ]+)\s*\$$", p)
    return int(m.group(1).replace(" ", "")) if m else None


def parse_vehicles(snaps):
    out = {}
    for s in snaps:
        imgs = {clean(re.sub(r"\s+", " ", a)): src for a, src in s["imgs"] if src.startswith(CDN)}
        L = lines(s["text"])
        for i, l in enumerate(L):
            if not l.startswith("ID ") or i + 3 >= len(L):
                continue
            vid = l[3:].strip()
            brand, name, price = L[i + 1], L[i + 2], L[i + 3]
            if not (PRICE.match(price) or price in STATUS):
                continue
            card = {"id": vid, "brand": brand, "name": name, "price": price}
            # «Салон», затем пары «Скорость / 295 км/ч» … до следующего ID
            j = i + 4
            if j < len(L) and L[j] not in ("Скорость", "Багажник", "Топливо", "Завоз"):
                card["salon"] = L[j]
                j += 1
            keys = {"Скорость": "speed", "Багажник": "trunk", "Топливо": "fuel", "Завоз": "stock"}
            while j + 1 < len(L) and L[j] in keys:
                card[keys[L[j]]] = L[j + 1]
                j += 2
            img = imgs.get(f"{brand} {name}")
            if img:
                card["img"] = img
            # последняя карточка на снимке может быть обрезана — берём самую полную
            if vid not in out or len(card) > len(out[vid]):
                out[vid] = card
    return sorted(out.values(), key=lambda c: (c["brand"].lower(), c["name"].lower()))


def parse_clothes(snaps):
    out = {}
    for s in snaps:
        _, gender, cat = s["label"].split("/")
        alts = [(re.sub(r", текстура \d+$", "", clean(a)), src) for a, src in s["imgs"] if a and src.startswith(CDN)]
        L = lines(s["text"])
        k = 0
        for i, l in enumerate(L):
            m = re.match(r"^(\d+) / (\d+)$", l)
            if not m:
                continue
            j = i + 1
            pgo = j < len(L) and L[j] == "ПГО"
            if pgo:
                j += 1
            if j + 2 >= len(L):
                continue
            kind, name, price = L[j], L[j + 1], L[j + 2]
            if not (PRICE.match(price) or price in STATUS):
                continue
            item = {"id": f"{m.group(1)}/{m.group(2)}", "gender": gender, "cat": cat, "name": name, "price": price}
            if pgo:
                item["pgo"] = True
            if j + 3 < len(L) and L[j + 3].startswith("Завоз:"):
                item["stock"] = L[j + 3].split(":", 1)[1].strip()
            # картинки идут в том же порядке, что и карточки
            while k < len(alts) and alts[k][0] != name:
                k += 1
            if k < len(alts):
                item["img"] = alts[k][1]
                k += 1
            out[(gender, item["id"], cat)] = item
    return sorted(out.values(), key=lambda c: (c["gender"], c["cat"], int(c["id"].split("/")[0]), int(c["id"].split("/")[1])))


def parse_hair(snaps):
    out = {}
    for s in snaps:
        gender = s["label"].split("/")[1]
        imgs = [src for a, src in s["imgs"] if a and src.startswith(CDN)]
        g_path = "/male/" if gender == "Мужские" else "/female/"
        imgs = [x for x in imgs if g_path in x]
        L = lines(s["text"])
        k = 0
        for i, l in enumerate(L):
            if not re.match(r"^\d+$", l):
                continue
            j = i + 1
            pgo = j < len(L) and L[j] == "ПГО"
            if pgo:
                j += 1
            if j + 1 >= len(L) or not (PRICE.match(L[j + 1]) or L[j + 1] in STATUS):
                continue
            item = {"id": int(l), "gender": gender, "name": L[j], "price": L[j + 1]}
            if pgo:
                item["pgo"] = True
            if k < len(imgs):
                item["img"] = imgs[k]
                k += 1
            out[(gender, item["id"])] = item
    # женские вкладки не переключились — оставляем только то, где картинки совпали с полом
    return sorted(out.values(), key=lambda c: (c["gender"], c["id"]))


def parse_items(snaps):
    out = {}
    for s in snaps:
        raw = [l.replace(NB, " ") for l in s["text"].split("\n")]
        # строки таблицы: Название, [описание], ID, Кол-во (кол-во — статистика сервера, не берём)
        rows = re.split(r"\n\s*\n\s*\n", "\n".join(raw))
        for r in rows:
            cells = [c.strip() for c in r.split("\n") if c.strip()]
            nums = [c for c in cells if re.match(r"^\d+$", c)]
            if not nums or len(cells) < 3:
                continue
            iid = nums[0]
            idx = cells.index(iid)
            head = cells[:idx]
            if not head or head[0] in ("Предмет", "Просмотр и редактирование"):
                continue
            name = head[0]
            desc = " ".join(head[1:])
            item = {"id": int(iid), "name": name, "img": f"{CDN}cloud/inventoryItems/items/{iid}.png"}
            if desc:
                item["desc"] = desc
            out[item["id"]] = item
    return sorted(out.values(), key=lambda c: c["name"].lower())


def parse_peds(text, imgs):
    pics = {a: src for a, src in imgs if a and src.startswith(CDN)}
    L = lines(text)
    out, group = [], ""
    i = L.index("Скины") + 2 if "Скины" in L else 0
    while i < len(L):
        l = L[i]
        if l == "DLC":
            i += 1
            continue
        if i + 1 < len(L) and re.match(r"^\d+$", L[i + 1]):
            group = l
            i += 2
            continue
        if i + 1 < len(L) and re.match(r"^[A-Za-z0-9_]+$", L[i + 1]):
            item = {"model": L[i + 1], "name": l, "group": group}
            if l in pics:
                item["img"] = pics[l]
            out.append(item)
            i += 2
            continue
        i += 1
    return out


def main():
    src = json.load(open(sys.argv[1], encoding="utf-8"))
    snaps = src["snaps"]
    by = lambda p: [s for s in snaps if s["label"] == p or s["label"].startswith(p + "/")]
    cat = {
        "at": src.get("at"),
        "vehicles": parse_vehicles(by("vehicles")),
        "clothes": parse_clothes(by("clothes")),
        "hair": parse_hair(by("hair")),
        "items": parse_items(by("items")),
    }
    # добор из второго файла (женская одежда, причёски, остальные машины и предметы)
    for extra in sys.argv[2:]:
        more = json.load(open(extra, encoding="utf-8")).get("snaps", [])
        by2 = lambda p: [s for s in more if s["label"] == p or s["label"].startswith(p + "/")]
        for key, fn, k in (("vehicles", parse_vehicles, "id"), ("items", parse_items, "id")):
            have = {x[k] for x in cat[key]}
            cat[key] += [x for x in fn(by2(key)) if x[k] not in have]
        for key, fn in (("clothes", parse_clothes), ("hair", parse_hair)):
            new = fn(by2(key))
            genders = {x["gender"] for x in new}
            cat[key] = [x for x in cat[key] if x["gender"] not in genders] + new
    # только то, что игрок видит в игре: без завоза, ПГО и кодов спавна
    for key in ("vehicles", "clothes", "hair", "items"):
        for x in cat[key]:
            for f in ("stock", "pgo"):
                x.pop(f, None)
    cat.pop("peds", None)
    # женские вкладки не переключались: оставляем только записи, где картинка того же пола
    for key, g, path in (("clothes", "Женская", "/female/"), ("hair", "Женские", "/female/")):
        cat[key] = [x for x in cat[key] if x["gender"] != g or path in x.get("img", "")]
    cat["vehicles"].sort(key=lambda c: (c["brand"].lower(), c["name"].lower()))
    cat["items"].sort(key=lambda c: c["name"].lower())
    dst = Path(__file__).resolve().parent.parent / "src" / "catalog.json"
    dst.write_text(json.dumps(cat, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for k in ("vehicles", "clothes", "hair", "items"):
        print(k, len(cat[k]))
    print("->", dst, round(dst.stat().st_size / 1024), "KB")


if __name__ == "__main__":
    main()
