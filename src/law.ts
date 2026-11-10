// Разбор текста темы с форума на пункты и поиск по ним.

export type Doc = {
  id: string;
  title: string;
  url: string;
  section: string;
  text: string;
  prevText?: string | null;
  fetchedAt: number;
  changedAt?: number | null;
};

export type Point = {
  key: string; // docId#index
  docId: string;
  num: string; // "2.4", "5.1" или "" для вступления
  chapter: string;
  text: string; // полный текст пункта вместе с номером
  idx: number;
};

const CHAPTER = /^(глава|раздел|часть|chapter)\s+([0-9ivxlcdm]+)\b.*$/i;
const ARTICLE = /^(?:статья|ст\.)\s*(\d{1,3}(?:\.\d{1,3})*)\.?/i;
const PUNKT = /^(?:пункт|п\.)\s*(\d{1,3}(?:\.\d{1,3})*)\.?/i;
const MULTI = /^(\d{1,3}(?:\.\d{1,3})+)\.?\)?(?:\s|$)/; // 1.1 / 1.1. / 2.4.3
const SINGLE = /^(\d{1,3})[.)](?:\s|$)/; // 1. / 1)

function pointNum(line: string): string | null {
  const l = line.replace(/^[•\-–—*]\s*/, "");
  for (const re of [ARTICLE, PUNKT, MULTI, SINGLE]) {
    const m = re.exec(l);
    if (m) return m[1];
  }
  return null;
}

// разобранные пункты по документу; сравниваем весь текст, чтобы любая правка сбрасывала кеш
const cache = new Map<string, { text: string; points: Point[] }>();

export function parsePoints(docId: string, text: string): Point[] {
  const hit = cache.get(docId);
  if (hit && hit.text === text) return hit.points;

  const out: Point[] = [];
  let chapter = "";
  let cur: { num: string; lines: string[]; chapter: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const t = cur.lines.join("\n").trim();
    if (t) out.push({ key: `${docId}#${out.length}`, docId, num: cur.num, chapter: cur.chapter, text: t, idx: out.length });
    cur = null;
  };

  // «:: Провокация госников» — заголовок следующего пункта, а не хвост предыдущего
  let head: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (CHAPTER.test(line) && line.length < 140) {
      flush();
      chapter = line;
      continue;
    }
    if (/^::/.test(line) && line.length < 140) {
      flush();
      head = line;
      continue;
    }
    const num = line ? pointNum(line) : null;
    if (num || (head && line)) {
      flush();
      cur = { num: num ?? "", lines: head ? [head, line] : [line], chapter };
      head = null;
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { num: "", lines: [line], chapter };
    }
  }
  flush();
  if (head) {
    cur = { num: "", lines: [head], chapter };
    flush();
  }
  cache.set(docId, { text, points: out });
  return out;
}

export const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

// Текст, набранный в английской раскладке вместо русской: "eujy" → "угон".
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = "йцукенгшщзхъфывапролджэячсмитьбё";
export function fixLayout(s: string): string {
  return [...s.toLowerCase()].map((c) => { const i = EN.indexOf(c); return i < 0 ? c : RU[i]; }).join("");
}
const looksLatin = (s: string) => /[a-z]/i.test(s) && !/[а-яё]/i.test(s);

// Основа слова: «машины», «машину», «машина» → «машин». Хватает, чтобы находить разные формы.
const ENDINGS = /(ями|ами|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ую|юю|ию|ть|ти|ся|сь|а|я|о|е|ы|и|у|ю|ь)$/;
export function stem(w: string): string {
  if (w.length < 5 || /\d/.test(w)) return w;
  const s = w.replace(ENDINGS, "");
  return s.length >= 4 ? s : w.slice(0, 4);
}

/** Наказание из текста пункта: строка «Наказание: …», «Санкция …» или «— 3 звезды». */
const PUNISH = /(?:^|\n)\s*[•\-–—*]?\s*(?:наказание|наказывается|санкци[яи]|мера наказания|выдается|выдаётся)\s*[:—–-]?\s*(.+)/i;
export function punishment(text: string): string | null {
  const m = PUNISH.exec(text);
  return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 160) : null;
}

export type Hit = { p: Point; doc: Doc; score: number };
export type Result = { hits: Hit[]; fixed: string | null; loose?: boolean; exact?: boolean };

// Слова, которые ничего не говорят о сути вопроса: «что будет если я …»
const STOP = /^(и|в|во|на|за|по|с|со|о|об|не|а|но|или|ли|бы|же|к|у|от|до|из|при|что|чё|че|будет|будут|если|когда|как|можно|нельзя|я|мне|меня|мы|ты|он|она|они|его|её|ее|их|это|этого|мой|моя|свой|за что)$/;
// Разговорные формы → слово, которым это записано в законах
const SPOKEN: [RegExp, string][] = [
  [/^(убь|убил|убит|убив|убий)/, "убийств"],
  [/^(украл|украд|своровал|сворую|спиз|спизд)/, "хищени"],
  [/^(угнал|угоню|угнать)/, "завладени"],
  [/^(оскорбил|оскорблю|обозвал)/, "оскорблени"],
];

function run(docs: Doc[], q: string, limit: number, loose = false): Hit[] {
  const numQ = /^(?:ст\.?|статья|п\.?|пункт)?\s*(\d{1,3}(\.\d{1,3})*)\.?$/.exec(q)?.[1] ?? null;
  const words = q
    .replace(/[?!.,;:«»"()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP.test(w))
    .map((w) => SPOKEN.find(([re]) => re.test(w))?.[1] ?? w);
  if (!numQ && !words.length) return [];
  const stems = words.map(stem);
  // мягкий поиск: однокоренные слова по началу («провокация» ↔ «провоцирующие»)
  const roots = words.map((w) => (loose && w.length >= 7 && !/\d/.test(w) ? w.slice(0, 5) : null));
  const hits: Hit[] = [];

  // мягкий поиск: редкие слова («провокация») весят больше частых («сотрудник», «исполнении»)
  let weight = words.map(() => 1);
  if (loose && !numQ) {
    const df = words.map(() => 0);
    let total = 0;
    for (const doc of docs)
      for (const p of parsePoints(doc.id, doc.text)) {
        total++;
        const t = norm(p.text);
        for (let k = 0; k < words.length; k++) if (t.includes(stems[k])) df[k]++;
      }
    weight = df.map((n) => Math.max(0.3, Math.log((total + 1) / (n + 1)) / 2));
  }

  for (const doc of docs) {
    const titleN = norm(doc.title);
    for (const p of parsePoints(doc.id, doc.text)) {
      let score = 0;
      if (numQ) {
        if (p.num === numQ) score = 100;
        else if (p.num.startsWith(numQ + ".")) score = 50 - p.num.length;
        else continue;
      } else {
        const t = norm(p.text);
        let missed = 0;
        for (let k = 0; k < words.length; k++) {
          const i = t.indexOf(words[k]);
          let j = i >= 0 ? i : t.indexOf(stems[k]);
          let base = i >= 0 ? 6 : 4;
          if (j < 0 && roots[k]) {
            j = t.indexOf(roots[k]!);
            base = 3;
          }
          if (j < 0) {
            if (titleN.includes(stems[k])) { score += 1; continue; }
            missed++;
            if (!loose) break;
            continue;
          }
          score += (base + (j < 80 ? 2 : 0)) * weight[k];
        }
        // строго — нужны все слова; мягко — хотя бы половина
        if (loose ? missed * 2 > words.length || missed === words.length : missed > 0) continue;
        if (words.length > 1 && t.includes(q)) score += 10;
        if (p.num) score += 1;
        score -= Math.min(5, t.length / 400);
      }
      hits.push({ p, doc, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// «ук», «ак 12.1», «6.2 пдд» — в каком документе искать номер
const DOC_HINTS: [RegExp, RegExp][] = [
  [/^(ук|уголовн\S*)$/, /уголовн/i],
  [/^(ак|коап|административн\S*)$/, /административн/i],
  [/^(пк|процессуальн\S*)$/, /процессуальн/i],
  [/^(дк|пдд|дорожн\S*)$/, /дорожн/i],
  [/^(правил\S*|пр)$/, /правил|регламент|rules/i],
];
const NUM_FILLER = /^(ст|статья|статью|статьи|ст\.|п|п\.|пункт|пункта|ч|ч\.|часть|№|n)$/;

/** «6.2», «ук 6.2», «статья 9.6 правил» — только сама статья, без подпунктов и похожих номеров. */
function exactNumber(docs: Doc[], q: string): Hit[] | null {
  const words = q.replace(/[,;:]/g, " ").replace(/(ст|п|ч)\.(?=\d)/g, "$1 ").split(/\s+/).filter(Boolean);
  let num: string | null = null;
  let hint: RegExp | null = null;
  for (const w of words) {
    const n = /^(\d{1,3}(?:\.\d{1,3})*)\.?$/.exec(w);
    if (n && !num) num = n[1];
    else if (NUM_FILLER.test(w)) continue;
    else {
      const h = DOC_HINTS.find(([re]) => re.test(w));
      if (!h || hint) return null; // в запросе есть что-то кроме номера — обычный поиск
      hint = h[1];
    }
  }
  if (!num) return null;
  const hits: Hit[] = [];
  for (const doc of docs) {
    if (hint && !hint.test(doc.section + " " + doc.title)) continue;
    for (const p of parsePoints(doc.id, doc.text)) if (p.num === num) hits.push({ p, doc, score: 100 });
  }
  return hits.length ? hits : null;
}

/** Поиск. Если ничего не нашлось, а запрос в латинице, — пробуем его в русской раскладке. */
export function search(docs: Doc[], query: string, limit = 150): Result {
  const q = norm(query.trim());
  if (!q) return { hits: [], fixed: null };
  const exact = exactNumber(docs, q);
  if (exact) return { hits: exact.slice(0, limit), fixed: null, exact: true };
  const ru = looksLatin(q) ? fixLayout(q) : null;
  let hits = run(docs, q, limit);
  if (hits.length) return { hits, fixed: null };
  if (ru && (hits = run(docs, ru, limit)).length) return { hits, fixed: ru };
  hits = run(docs, ru ?? q, limit, true);
  return { hits, fixed: hits.length ? ru : null, loose: hits.length > 0 };
}

export type Change = { num: string; kind: "added" | "removed" | "changed"; before?: string; after?: string };

/** Что поменялось в документе между прошлой и текущей версией. */
export function diffDoc(doc: Doc): Change[] {
  if (!doc.prevText) return [];
  const byNum = (pts: Point[]) => {
    const m = new Map<string, string>();
    pts.forEach((p, i) => m.set(p.num || `#${i}`, p.text));
    return m;
  };
  const a = byNum(parsePoints(doc.id + "-old", doc.prevText));
  const b = byNum(parsePoints(doc.id, doc.text));
  const out: Change[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) out.push({ num: k, kind: "added", after: v });
    else if (a.get(k) !== v) out.push({ num: k, kind: "changed", before: a.get(k), after: v });
  }
  for (const [k, v] of a) if (!b.has(k)) out.push({ num: k, kind: "removed", before: v });
  return out;
}

/** Кусок текста вокруг первого совпадения. */
export function snippet(text: string, query: string, len = 220): string {
  const flat = text.replace(/\s*\n\s*/g, " ");
  const w = norm(query).split(/\s+/).find((x) => x && !/^\d/.test(x));
  if (!w || flat.length <= len) return flat.length > len ? flat.slice(0, len) + "…" : flat;
  const nf = norm(flat);
  let i = nf.indexOf(w);
  if (i < 0) i = nf.indexOf(stem(w));
  if (i < 0) return flat.slice(0, len) + "…";
  const start = Math.max(0, i - 60);
  return (start ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length ? "…" : "");
}
