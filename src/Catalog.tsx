import { useEffect, useMemo, useState } from "react";

// Каталог Trace: транспорт, одежда, причёски, предметы — названия, цены, картинки.
// Данные лежат в src/catalog.json (собирает tools/parse_catalog.py), грузятся только при открытии каталога.

type Vehicle = { id: string; brand: string; name: string; price: string; salon?: string; speed?: string; trunk?: string; fuel?: string; img?: string };
type Cloth = { id: string; gender: string; cat: string; name: string; price: string; img?: string };
type Hair = { id: number; gender: string; name: string; price: string; img?: string };
type Item = { id: number; name: string; desc?: string; img?: string };
type Data = { at?: string; vehicles: Vehicle[]; clothes: Cloth[]; hair: Hair[]; items: Item[] };
type Tab = "vehicles" | "clothes" | "hair" | "items";
type Sort = "price-asc" | "price-desc" | "name";

const TABS: [Tab, string][] = [["vehicles", "Транспорт"], ["clothes", "Одежда"], ["hair", "Причёски"], ["items", "Предметы"]];
const PAGE = 60;
const CDN = "https://cdn.trace-rp.com/cloud/";
/** картинки для карточек главного экрана — из самого каталога Trace */
const HERO = {
  vehicles: ["vehicle:gtr50", "vehicle:i8"],
  person: [CDN + "inventoryItems/clothes/male/tops/a903b604.webp", CDN + "img/appearance-shop/previews/barber/male/hair_39_0.webp"],
  items: [CDN + "inventoryItems/items/1.png", CDN + "inventoryItems/items/202.png", CDN + "inventoryItems/items/13.png"],
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
/** «2 150 000 000 $» → число (TC и «Не продаётся» — в конец списка) */
const priceNum = (p: string) => {
  const m = p.replace(/\s/g, "").match(/^(\d+)\$$/);
  return m ? +m[1] : Number.POSITIVE_INFINITY;
};
const priceClass = (p: string) => (/\$$/.test(p) ? "" : /TC$/.test(p) ? "tc" : "off");

function useCatalog() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    import("./catalog.json").then((m) => setData(m.default as unknown as Data)).catch(() => {});
  }, []);
  return data;
}

function Chips<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="cat-chips">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

function Pic({ src, alt }: { src?: string; alt: string }) {
  const [bad, setBad] = useState(false);
  return (
    <div className="cat-pic">
      {src && !bad ? <img src={src} alt={alt} loading="lazy" draggable={false} onError={() => setBad(true)} /> : <span>нет фото</span>}
    </div>
  );
}

export default function Catalog({ onCopy }: { onCopy: (text: string, what: string) => void }) {
  const data = useCatalog();
  const [tab, setTab] = useState<Tab | null>(null);
  const [q, setQ] = useState("");
  const [gender, setGender] = useState<"Мужская" | "Женская">("Мужская");
  const [cat, setCat] = useState("Все");
  const [salon, setSalon] = useState("Все");
  const [sort, setSort] = useState<Sort>("price-asc");
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => setLimit(PAGE), [tab, q, gender, cat, salon, sort]);

  const hasFemale = (data?.clothes ?? []).some((c) => c.gender === "Женская");
  const hairGender = gender === "Мужская" ? "Мужские" : "Женские";
  const hasFemaleHair = (data?.hair ?? []).some((h) => h.gender === "Женские");

  const cats = useMemo(() => ["Все", ...new Set((data?.clothes ?? []).filter((c) => c.gender === gender).map((c) => c.cat))], [data, gender]);
  const salons = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of data?.vehicles ?? []) if (v.salon) m.set(v.salon, (m.get(v.salon) ?? 0) + 1);
    return ["Все", ...[...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0])];
  }, [data]);

  const list = useMemo(() => {
    if (!data) return [];
    const words = norm(q).split(/\s+/).filter(Boolean);
    const match = (...fields: (string | undefined)[]) => {
      const hay = norm(fields.filter(Boolean).join(" "));
      return words.every((w) => hay.includes(w));
    };
    const sorter = <T extends { name: string; price?: string }>(a: T, b: T) =>
      sort === "name" ? a.name.localeCompare(b.name, "ru")
        : sort === "price-asc" ? priceNum(a.price ?? "") - priceNum(b.price ?? "") || a.name.localeCompare(b.name, "ru")
          : (priceNum(b.price ?? "") === Infinity ? -1 : priceNum(b.price ?? "")) - (priceNum(a.price ?? "") === Infinity ? -1 : priceNum(a.price ?? "")) || a.name.localeCompare(b.name, "ru");
    if (tab === "vehicles") return data.vehicles.filter((v) => (salon === "Все" || v.salon === salon) && match(v.brand, v.name, v.salon)).sort(sorter);
    if (tab === "clothes") {
      // одинаковые вещи разных расцветок показываем один раз
      const seen = new Set<string>();
      return data.clothes
        .filter((c) => c.gender === gender && (cat === "Все" || c.cat === cat) && match(c.name, c.cat))
        .filter((c) => { const k = c.cat + c.name + c.price; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort(sorter);
    }
    if (tab === "hair") return data.hair.filter((h) => h.gender === hairGender && match(h.name)).sort(sorter);
    if (tab === "items") return data.items.filter((i) => i.name !== "???" && match(i.name, i.desc)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return [];
  }, [data, tab, q, gender, cat, salon, sort, hairGender]);

  if (!data) return <div className="muted pad">Загружаю каталог…</div>;

  const open = (t: Tab, opts: { salon?: string; gender?: "Мужская" | "Женская" } = {}) => {
    setTab(t); setQ(""); setCat("Все"); setSalon(opts.salon ?? "Все");
    if (opts.gender) setGender(opts.gender);
  };
  if (!tab) {
    const vimg = (id: string) => data.vehicles.find((v) => v.id === id.split(":")[1])?.img;
    const count = (n: number) => n.toLocaleString("ru-RU");
    const vehicleChips = salons.filter((x) => x !== "Все" && !/^Салон \d+$|^Без салона$/.test(x)).slice(0, 7);
    return (
      <div className="catalog">
        <h1 className="h">Каталог Trace</h1>
        <div className="hub">
          <div className="hub-card" onClick={() => open("vehicles")}>
            <div className="hub-text">
              <h2>Транспорт</h2>
              <div className="muted small">{count(data.vehicles.length)} моделей: цены, салоны, скорость, багажник</div>
              <div className="hub-chips" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => open("vehicles")}>Все</button>
                {vehicleChips.map((x) => <button key={x} onClick={() => open("vehicles", { salon: x })}>{x}</button>)}
              </div>
            </div>
            <div className="hub-art">{HERO.vehicles.map((h, i) => vimg(h) && <img key={h} className={`a${i}`} src={vimg(h)} alt="" draggable={false} />)}</div>
          </div>
          <div className="hub-card" onClick={() => open("clothes")}>
            <div className="hub-text">
              <h2>Персонаж</h2>
              <div className="muted small">Одежда и причёски с ценами</div>
              <div className="hub-chips" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => open("clothes", { gender: "Мужская" })}>Одежда · М</button>
                <button onClick={() => open("clothes", { gender: "Женская" })}>Одежда · Ж</button>
                <button onClick={() => open("hair", { gender: "Мужская" })}>Причёски · М</button>
                <button onClick={() => open("hair", { gender: "Женская" })}>Причёски · Ж</button>
              </div>
            </div>
            <div className="hub-art">{HERO.person.map((h, i) => <img key={h} className={`a${i}`} src={h} alt="" draggable={false} />)}</div>
          </div>
          <div className="hub-card" onClick={() => open("items")}>
            <div className="hub-text">
              <h2>Предметы</h2>
              <div className="muted small">Что это и для чего нужно</div>
              <div className="hub-chips" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => open("items")}>Все предметы</button>
              </div>
            </div>
            <div className="hub-art items">{HERO.items.map((h, i) => <img key={h} className={`a${i}`} src={h} alt="" draggable={false} />)}</div>
          </div>
        </div>
      </div>
    );
  }
  const shown = list.slice(0, limit);

  return (
    <div className="catalog">
      <div className="cat-top">
        <button className="link" onClick={() => setTab(null)}>‹ Каталог</button>
        <Chips value={tab} options={TABS} onChange={(t) => { setTab(t); setQ(""); }} />
      </div>

      <div className="cat-filters">
        <input className="cat-search" placeholder="Поиск по каталогу" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }} />
        {(tab === "clothes" || tab === "hair") && (
          <Chips value={gender} options={[["Мужская", tab === "hair" ? "Мужские" : "Мужская"], ["Женская", tab === "hair" ? "Женские" : "Женская"]]} onChange={setGender} />
        )}
        {tab !== "items" && (
          <select className="cat-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="Сортировка">
            <option value="price-asc">Сначала дешёвые</option>
            <option value="price-desc">Сначала дорогие</option>
            <option value="name">По названию</option>
          </select>
        )}
      </div>

      {tab === "vehicles" && <Chips value={salon} options={salons.map((s) => [s, s] as [string, string])} onChange={setSalon} />}
      {tab === "clothes" && <Chips value={cat} options={cats.map((s) => [s, s] as [string, string])} onChange={setCat} />}

      {((tab === "clothes" && gender === "Женская" && !hasFemale) || (tab === "hair" && gender === "Женская" && !hasFemaleHair)) ? (
        <div className="muted pad">Женский раздел скоро добавим.</div>
      ) : (
        <>
          <div className="muted small cat-count">{list.length} шт.</div>
          <div className={`cat-grid ${tab}`}>
            {tab === "vehicles" && (shown as Vehicle[]).map((v) => (
              <div key={v.id} className="cat-card" title="Клик — скопировать название" onClick={() => onCopy(`${v.brand} ${v.name}`, "Название")}>
                <Pic src={v.img} alt={v.name} />
                <div className="cat-body">
                  <div className="cat-sub">{v.brand}</div>
                  <div className="cat-name">{v.name}</div>
                  <div className={`cat-price ${priceClass(v.price)}`}>{v.price}</div>
                  <div className="cat-specs">
                    {v.salon && <span>{v.salon}</span>}
                    {v.speed && v.speed !== "???" && <span>{v.speed}</span>}
                    {v.trunk && <span>багажник {v.trunk}</span>}
                    {v.fuel && <span>{v.fuel}</span>}
                  </div>
                </div>
              </div>
            ))}
            {tab === "clothes" && (shown as Cloth[]).map((c) => (
              <div key={c.gender + c.cat + c.id} className="cat-card" title="Клик — скопировать название" onClick={() => onCopy(c.name, "Название")}>
                <Pic src={c.img} alt={c.name} />
                <div className="cat-body">
                  <div className="cat-sub">{c.cat}</div>
                  <div className="cat-name">{c.name}</div>
                  <div className={`cat-price ${priceClass(c.price)}`}>{c.price}</div>
                </div>
              </div>
            ))}
            {tab === "hair" && (shown as Hair[]).map((h) => (
              <div key={h.gender + h.id} className="cat-card" title="Клик — скопировать название" onClick={() => onCopy(h.name, "Название")}>
                <Pic src={h.img} alt={h.name} />
                <div className="cat-body">
                  <div className="cat-name">{h.name}</div>
                  <div className={`cat-price ${priceClass(h.price)}`}>{h.price}</div>
                </div>
              </div>
            ))}
            {tab === "items" && (shown as Item[]).map((i) => (
              <div key={i.id} className="cat-card" title="Клик — скопировать название" onClick={() => onCopy(i.name, "Название")}>
                <Pic src={i.img} alt={i.name} />
                <div className="cat-body">
                  <div className="cat-name">{i.name}</div>
                  {i.desc && <div className="cat-desc">{i.desc}</div>}
                </div>
              </div>
            ))}
          </div>
          {list.length > limit && (
            <button className="btn cat-more" onClick={() => setLimit(limit + PAGE * 2)}>Показать ещё ({list.length - limit})</button>
          )}
          {list.length === 0 && <div className="muted pad">Ничего не нашлось.</div>}
        </>
      )}
    </div>
  );
}
