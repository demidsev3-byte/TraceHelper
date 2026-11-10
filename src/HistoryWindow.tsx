// Окно истории справа от хелпера: открытые статьи, поиск по ним, клик — статья открывается в хелпере.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Doc, norm, parsePoints, snippet } from "./law";

type Recent = { docId: string; num: string; at: number };

const isRules = (d: Doc) => /правил|регламент|rules/i.test(d.section + " " + d.title);
const cleanTitle = (t: string) => t.replace(/^ИНФОРМАЦИЯ\s*/i, "").trim();

function loadRecent(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("recent") || "[]");
  } catch {
    return [];
  }
}

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return time;
  return d.toLocaleDateString("ru", { day: "numeric", month: "short" }) + " " + time;
}

export default function HistoryWindow() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loadDocs = (n = 10) =>
      invoke<Doc[]>("get_docs").then(setDocs).catch(() => n > 0 && setTimeout(() => loadDocs(n - 1), 300));
    loadDocs();
    const reload = () => setRecent(loadRecent());
    window.addEventListener("storage", reload);
    window.addEventListener("focus", reload);
    const uns = [
      listen("docs-updated", () => loadDocs()),
      listen("history-shown", () => {
        reload();
        setQ("");
        input.current?.focus();
      }),
    ];
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && invoke("history_hide").catch(() => {});
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener("focus", reload);
      window.removeEventListener("keydown", onKey);
      uns.forEach((u) => u.then((f) => f()));
    };
  }, []);

  const rows = useMemo(() => {
    const byId = new Map(docs.map((d) => [d.id, d]));
    const nq = norm(q.trim());
    return recent
      .map((r) => {
        const doc = byId.get(r.docId);
        const p = doc && parsePoints(doc.id, doc.text).find((x) => x.num === r.num);
        return doc && p ? { r, doc, p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .filter((x) => !nq || norm(`${x.p.num} ${x.doc.title} ${x.p.text}`).includes(nq));
  }, [recent, docs, q]);

  const changed = docs.filter((d) => d.prevText).length;

  const clear = () => {
    try { localStorage.setItem("recent", "[]"); } catch {}
    setRecent([]);
  };

  return (
    <div className="hw">
      <div className="hw-head" data-tauri-drag-region>
        <span className="hw-title" data-tauri-drag-region>История</span>
        {recent.length > 0 && <button className="hw-btn" title="Очистить историю" onClick={clear}>Очистить</button>}
        <button className="hw-x" title="Закрыть (Esc)" onClick={() => invoke("history_hide").catch(() => {})}>✕</button>
      </div>
      <div className="hw-search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в истории" spellCheck={false} />
      </div>
      <div className="hw-list">
        {rows.length === 0 ? (
          <div className="hw-empty">
            <div className="hw-empty-t">{recent.length ? "Ничего не нашлось" : "Здесь будут статьи, которые ты открывал"}</div>
            {!recent.length && <div className="muted small">Найди статью в строке поиска и открой её — она сохранится сюда.</div>}
          </div>
        ) : (
          rows.map(({ r, doc, p }) => (
            <button key={r.docId + r.num} className="hw-row" onClick={() => invoke("history_open", { docId: doc.id, num: p.num }).catch(() => {})}>
              <div className="hw-row-head">
                {p.num && <span className="num">{p.num}</span>}
                <span className={`kind ${isRules(doc) ? "r" : "l"}`}>{isRules(doc) ? "Правила" : "Закон"}</span>
                <span className="hw-doc">{cleanTitle(doc.title)}</span>
                <span className="hw-time">{when(r.at)}</span>
              </div>
              <div className="hw-text">{snippet(p.text, "", 150)}</div>
            </button>
          ))
        )}
      </div>
      {changed > 0 && (
        <button className="hw-changes" onClick={() => invoke("history_open", { docId: "", num: "" }).catch(() => {})}>
          Изменения в законах: {changed} — посмотреть
        </button>
      )}
    </div>
  );
}
