// Карточка голоса в игре: Ctrl+Пробел → говоришь → справа появляется найденная статья и история запросов.
// Окно не забирает фокус у игры: клавиатура остаётся в игре, мышью можно листать и кликать.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Doc, Point, parsePoints, punishment, search } from "./law";
import { VoiceSession, startVoice } from "./voice";

type Phase = "idle" | "listening" | "processing" | "result" | "error";
type Entry = { q: string; docId: string; idx: number; num: string; at: number };
type Found = { doc: Doc; p: Point };

const HIDE_AFTER = 25000; // карточка с ответом сама прячется
const HIDE_ERROR = 4000;

const isRules = (d: Doc) => /правил|регламент|rules/i.test(d.section + " " + d.title);
const cleanTitle = (t: string) => t.replace(/^ИНФОРМАЦИЯ\s*/i, "").trim();

function loadHistory(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem("voiceHistory") || "[]");
  } catch {
    return [];
  }
}

export default function VoiceCard() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Entry[]>(loadHistory);
  const session = useRef<VoiceSession | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const docsRef = useRef<Doc[]>([]);
  docsRef.current = docs;
  const hideTimer = useRef(0);
  const hovered = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => invoke<Doc[]>("get_docs").then(setDocs).catch(() => {});
    load();
    const un = listen("docs-updated", load);
    return () => void un.then((f) => f());
  }, []);

  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    session.current?.cancel();
    setPhase("idle");
    invoke("voice_hide").catch(() => {});
  }, []);

  const hideLater = useCallback(
    (ms: number) => {
      clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => (hovered.current ? hideLater(ms) : hide()), ms);
    },
    [hide],
  );

  const showQuery = useCallback(
    (q: string) => {
      const hits = search(docsRef.current, q, 40).hits.slice(0, 4).map((h) => ({ doc: h.doc, p: h.p }));
      setQuery(q);
      setFound(hits);
      setShown(0);
      setPhase("result");
      hideLater(HIDE_AFTER);
      if (hits[0]) {
        const e: Entry = { q, docId: hits[0].doc.id, idx: hits[0].p.idx, num: hits[0].p.num, at: Date.now() };
        setHistory((h) => {
          const next = [e, ...h.filter((x) => x.q.toLowerCase() !== q.toLowerCase())].slice(0, 8);
          try { localStorage.setItem("voiceHistory", JSON.stringify(next)); } catch {}
          return next;
        });
      }
    },
    [hideLater],
  );

  const start = useCallback(async () => {
    const ph = phaseRef.current;
    if (ph === "listening") return session.current?.stop();
    if (ph === "processing") return;
    clearTimeout(hideTimer.current);
    setError("");
    session.current = await startVoice(
      (t) => showQuery(t),
      (s) => {
        // после распознавания фазу ставит showQuery или ошибка
        if (s === "listening" || s === "processing") setPhase(s);
      },
      (msg) => {
        setError(msg);
        setPhase("error");
        hideLater(HIDE_ERROR);
      },
    );
    if (!session.current) hideLater(HIDE_ERROR);
  }, [showQuery, hideLater]);

  useEffect(() => {
    const un = listen("voice-hotkey-card", () => start());
    return () => void un.then((f) => f());
  }, [start]);

  // высота окна = высота карточки
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => invoke("voice_resize", { height: Math.ceil(el.getBoundingClientRect().height) + 24 }).catch(() => {}));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const openHistory = (e: Entry) => {
    const doc = docs.find((d) => d.id === e.docId);
    const p = doc && (parsePoints(doc.id, doc.text)[e.idx] ?? parsePoints(doc.id, doc.text).find((x) => x.num === e.num));
    if (!doc || !p) return showQuery(e.q);
    setQuery(e.q);
    setFound([{ doc, p }]);
    setShown(0);
    setPhase("result");
    hideLater(HIDE_AFTER);
  };

  const cur = found[shown];
  const pun = cur ? punishment(cur.p.text) : null;

  return (
    <div
      className="vc-wrap"
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => (hovered.current = false)}
    >
      <div className="vc" ref={root}>
        <div className="vc-head">
          {phase === "listening" && <><span className="vc-dot" /> Слушаю… говори</>}
          {phase === "processing" && <><span className="spinner" /> Распознаю…</>}
          {phase === "result" && <span className="vc-q">🎤 «{query}»</span>}
          {phase === "error" && <span className="vc-err">{error}</span>}
          {phase === "idle" && <span className="muted">Ctrl+Пробел — сказать голосом</span>}
          <button className="vc-x" title="Закрыть" onClick={hide}>✕</button>
        </div>

        {phase === "listening" && <div className="vc-hint">Договори — остановится само. Ctrl+Пробел — закончить сразу.</div>}

        {phase === "result" && !cur && (
          <div className="vc-none">Ничего не нашлось. Скажи по-другому: короче или другими словами.</div>
        )}

        {phase === "result" && cur && (
          <div className="vc-body">
            <div className="vc-meta">
              <span className={`kind ${isRules(cur.doc) ? "r" : "l"}`}>{isRules(cur.doc) ? "Правила" : "Закон"}</span>
              {cur.p.num && <span className="num">{cur.p.num}</span>}
              <span className="vc-doc">{cleanTitle(cur.doc.title)}</span>
            </div>
            <div className="vc-text">{cur.p.text}</div>
            {pun && <div className="pun"><b>Наказание</b>{pun}</div>}
            <div className="vc-actions">
              <button className="btn" onClick={() => invoke("voice_open", { docId: cur.doc.id, num: cur.p.num }).catch(() => {})}>Открыть в хелпере</button>
              {found.length > 1 && (
                <div className="vc-more">
                  {found.map((f, i) => (
                    <button key={f.p.key} className={i === shown ? "on" : ""} title={cleanTitle(f.doc.title)} onClick={() => { setShown(i); hideLater(HIDE_AFTER); }}>
                      {f.p.num || i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {history.length > 0 && phase !== "listening" && phase !== "processing" && (
          <div className="vc-hist">
            <div className="vc-hist-t">История</div>
            {history.map((e) => {
              const doc = docs.find((d) => d.id === e.docId);
              return (
                <button key={e.at} className="vc-hist-row" onClick={() => openHistory(e)}>
                  <span className="vc-hist-q">{e.q}</span>
                  <span className="muted">{doc ? `${isRules(doc) ? "Правила" : shortDoc(doc.title)} ${e.num}` : e.num}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** «Уголовный Кодекс Штата…» → «УК», остальное — первые слова. */
function shortDoc(t: string): string {
  const s = cleanTitle(t);
  if (/уголовн/i.test(s)) return "УК";
  if (/административн/i.test(s)) return "АК";
  if (/процессуальн/i.test(s)) return "ПК";
  if (/дорожн/i.test(s)) return "ДК";
  return s.split(/\s+/).slice(0, 2).join(" ");
}
