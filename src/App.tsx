import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Doc, Point, diffDoc, norm, parsePoints, punishment, search, snippet, stem } from "./law";
import "@fontsource-variable/geologica";
import { VoiceSession, clientId, startVoice } from "./voice";
import { AiAnswer, askAi } from "./ai";
import { getVersion } from "@tauri-apps/api/app";
import "./App.css";
import logoUrl from "./assets/logo.svg";
import Catalog from "./Catalog";

type Settings = {
  hotkey: string;
  alwaysOnTop: boolean;
  streamerMode: boolean;
  hideOnBlur: boolean;
  copyOnClick: boolean;
  autoUpdate: boolean;
  voiceOverlay: boolean;
  scale: number;
  showPromo: boolean;
  showCredit: boolean;
  autostart: boolean;
};

/** промокод автора, кнопка в строке копирует «/promo filosov» */
const PROMO = "filosov";

const clampScale = (v: number) => Math.round(Math.min(1.5, Math.max(0.7, v)) * 10) / 10;
type Panel = "library" | "history" | "settings" | "notes" | "catalog";
type View = { kind: "home" } | { kind: "doc"; id: string; point?: number } | { kind: Panel };
type Crawl = { active: boolean; left: number; savedNow: number };
type Kind = "rules" | "laws" | null;
type Recent = { docId: string; num: string; at: number };
type Note = { id: string; title: string; text: string; at: number };

function loadNotes(): Note[] {
  try {
    return JSON.parse(localStorage.getItem("notes") || "[]");
  } catch {
    return [];
  }
}

const fmtDate = (s?: number | null) =>
  s ? new Date(s * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** Правила сервера отдельно от законов штата — по названию темы или раздела. */
const isRules = (d: Doc) => /правил|регламент|rules/i.test(d.section + " " + d.title);

function loadRecent(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("recent") || "[]");
  } catch {
    return [];
  }
}

function Highlight({ text, query }: { text: string; query: string }) {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 1 && !/^\d/.test(w)).map(stem);
  if (!words.length) return <>{text}</>;
  const re = new RegExp("(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/е/g, "[её]")).join("|") + ")", "gi");
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

const Icon = {
  book: (
    <svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5zM20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5a2.5 2.5 0 0 1 2.5 2.5z" /></svg>
  ),
  history: (
    <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 7v5l3 2" /></svg>
  ),
  note: (
    <svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M8.5 12h7M8.5 16h5" /></svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></svg>
  ),
  shop: (
    <svg viewBox="0 0 24 24"><path d="M3 9h18l-1.5 11a1 1 0 0 1-1 .9H5.5a1 1 0 0 1-1-.9zM8 9V7a4 4 0 0 1 8 0v2" /></svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
  ),
};

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>(() => {
    try { return (localStorage.getItem("kind") as Kind) || null; } catch { return null; }
  });
  const [view, setView] = useState<View>({ kind: "home" });
  const [back, setBack] = useState<View[]>([]);
  const [fwd, setFwd] = useState<View[]>([]);
  const [sel, setSel] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [crawl, setCrawl] = useState<Crawl | null>(null);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [update, setUpdate] = useState<string | null>(null);
  const [ai, setAi] = useState<AiAnswer | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const runAi = async () => {
    const q = query.trim();
    if (q.length < 3 || aiBusy) return;
    setAiBusy(true);
    setAi(null);
    try {
      const a = await askAi(docs, q);
      setAi(a);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
    setAiBusy(false);
  };
  // новый запрос — старый ответ ИИ убираем
  useEffect(() => {
    if (ai && ai.question !== query.trim()) setAi(null);
  }, [query]);
  const [notes, setNotes] = useState<Note[]>(loadNotes);
  const [noteId, setNoteId] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem("notes", JSON.stringify(notes)); } catch {}
  }, [notes]);
  const noteHits = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return [];
    const ws = q.split(/\s+/).map(stem);
    return notes.filter((n) => { const t = norm(n.title + " " + n.text); return ws.every((w) => t.includes(w)); }).slice(0, 5);
  }, [notes, query]);
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);

  const say = useCallback((t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }, []);
  const [pinned, setPinned] = useState(false);
  const togglePin = useCallback(async () => {
    const next = !pinned;
    try {
      await invoke("set_pinned", { pinned: next });
      setPinned(next);
      say(next ? "Закреплено: хелпер висит поверх игры, управление в игре. Alt+Q — вернуться к поиску" : "Откреплено");
    } catch (e) {
      say(String(e));
    }
  }, [pinned, say]);
  const [voice, setVoice] = useState<"idle" | "listening" | "processing">("idle");
  const voiceRef = useRef<VoiceSession | null>(null);
  const toggleVoice = useCallback(async () => {
    if (voice === "listening") return voiceRef.current?.stop();
    if (voice === "processing") return;
    voiceRef.current = await startVoice(
      (t) => voiceTextRef.current(t),
      setVoice,
      say,
    );
  }, [voice, say]);
  const toggleVoiceRef = useRef(toggleVoice);
  toggleVoiceRef.current = toggleVoice;

  // при запуске программа может ещё не быть готова — повторяем несколько раз
  const retry = <T,>(cmd: string, ok: (v: T) => void, n = 10) =>
    invoke<T>(cmd).then(ok).catch(() => { if (n > 0) setTimeout(() => retry(cmd, ok, n - 1), 300); });
  const loadDocs = useCallback(() => retry<Doc[]>("get_docs", setDocs), []);
  const loadSettings = useCallback(() => retry<Settings>("get_settings", setSettings), []);

  const syncAll = useCallback(async () => {
    try {
      const n = await invoke<number>("sync_all");
      say(n ? `Обновляю ${n} документов…` : "Открываю форум");
    } catch (e) {
      say(String(e));
    }
  }, [say]);

  useEffect(() => {
    loadDocs();
    loadSettings();
    const uns = [
      listen("docs-updated", () => loadDocs()),
      listen<Crawl>("crawl-status", (e) => setCrawl(e.payload)),
      listen("focus-search", () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      }),
      listen("tray-sync", () => syncAll()),
      listen<string>("update-available", (e) => setUpdate(e.payload)),
      // Ctrl+Пробел занят глобально: когда окно в фокусе, приходит сюда
      listen("voice-hotkey-main", () => toggleVoiceRef.current()),
      // «Открыть в хелпере» из карточки голоса
      listen<[string, string]>("open-point", (e) => openPointRef.current(e.payload[0], e.payload[1])),
      listen("show-changes", () => goRef.current({ kind: "history" })),
    ];
    return () => uns.forEach((u) => u.then((f) => f()));
  }, []);

  useEffect(() => {
    try { kind ? localStorage.setItem("kind", kind) : localStorage.removeItem("kind"); } catch {}
  }, [kind]);

  const filtered = useMemo(() => (kind ? docs.filter((d) => isRules(d) === (kind === "rules")) : docs), [docs, kind]);
  // в выбранном разделе точных совпадений нет — ищем во всех (провокация есть в Правилах, а не в Законах)
  const res = useMemo(() => {
    const r = search(filtered, query);
    if (!kind || (!r.loose && r.hits.length)) return { ...r, wide: false };
    const all = search(docs, query);
    if (all.hits.length && (!all.loose || r.loose || !r.hits.length)) return { ...all, wide: true };
    return { ...r, wide: false };
  }, [filtered, docs, kind, query]);
  const hits = res.hits;
  const hlQuery = res.fixed ?? query;
  const changed = useMemo(() => docs.filter((d) => d.prevText), [docs]);
  useEffect(() => setSel(0), [query, kind]);

  const curDoc = view.kind === "doc" ? docs.find((d) => d.id === view.id) : undefined;
  const curPoints = useMemo(() => (curDoc ? parsePoints(curDoc.id, curDoc.text) : []), [curDoc]);

  // строка раскрывается в панель, только когда есть что показать
  const expanded = view.kind !== "home" || query.trim().length > 0 || (kind === "laws" && docs.length > 0 && docs.every(isRules));
  useEffect(() => {
    invoke("set_expanded", { expanded }).catch(() => {});
  }, [expanded]);

  const go = useCallback(
    (v: View) => {
      setBack((b) => [...b.slice(-50), view]);
      setFwd([]);
      setView(v);
    },
    [view],
  );
  const goBack = () => {
    if (!back.length) return setView({ kind: "home" });
    setFwd((f) => [view, ...f]);
    setView(back[back.length - 1]);
    setBack((b) => b.slice(0, -1));
  };
  const goFwd = () => {
    if (!fwd.length) return;
    setBack((b) => [...b, view]);
    setView(fwd[0]);
    setFwd((f) => f.slice(1));
  };
  const openNote = (id: string) => { setNoteId(id); go({ kind: "notes" }); };
  const toggle = (k: Panel) => (view.kind === k ? setView({ kind: "home" }) : go({ kind: k }));

  function openPoint(doc: Doc, p: Point) {
    go({ kind: "doc", id: doc.id, point: p.idx });
    if (!p.num) return;
    const next = [{ docId: doc.id, num: p.num, at: Date.now() }, ...recent.filter((r) => !(r.docId === doc.id && r.num === p.num))].slice(0, 30);
    setRecent(next);
    try { localStorage.setItem("recent", JSON.stringify(next)); } catch {}
  }

  // голос — это поиск статьи: сказал, и сразу открывается лучшая находка. «Назад» — к списку остальных
  const voiceTextRef = useRef((_t: string) => {});
  voiceTextRef.current = (t) => {
    setQuery(t);
    searchRef.current?.focus();
    const top = search(docs, t).hits[0];
    if (!top) return setView({ kind: "home" });
    setBack((b) => [...b.slice(-50), { kind: "home" }]);
    setFwd([]);
    setView({ kind: "doc", id: top.doc.id, point: top.p.idx });
    if (top.p.num) {
      const next = [{ docId: top.doc.id, num: top.p.num, at: Date.now() }, ...recent.filter((r) => !(r.docId === top.doc.id && r.num === top.p.num))].slice(0, 30);
      setRecent(next);
      try { localStorage.setItem("recent", JSON.stringify(next)); } catch {}
    }
  };

  // размер окна: Ctrl+колесо, Ctrl+плюс/минус, Ctrl+0 — как было
  const scaleRef = useRef((_v: number) => {});
  scaleRef.current = (v) => {
    if (!settings) return;
    const scale = clampScale(v);
    if (scale === (settings.scale || 1)) return;
    const next = { ...settings, scale };
    const { autostart: _a, ...rest } = next;
    invoke("set_settings", { settings: rest })
      .then(() => {
        setSettings(next);
        say(`Размер ${Math.round(scale * 100)}%`);
      })
      .catch((e) => say(String(e)));
  };
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      scaleRef.current((settings?.scale || 1) + (e.deltaY < 0 ? 0.1 : -0.1));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [settings]);

  const goRef = useRef(go);
  goRef.current = go;
  const openPointRef = useRef((_id: string, _num: string) => {});
  openPointRef.current = (id, num) => {
    const doc = docs.find((d) => d.id === id);
    const p = doc && parsePoints(doc.id, doc.text).find((x) => x.num === num);
    if (doc && p) openPoint(doc, p);
    else if (doc) go({ kind: "doc", id: doc.id });
  };

  async function copyPoint(p: Point, doc?: Doc) {
    const d = doc ?? docs.find((x) => x.id === p.docId);
    await navigator.clipboard.writeText(p.text + (d ? `\n(${d.title})` : ""));
    say(p.num ? `Пункт ${p.num} скопирован` : "Скопировано");
  }

  const fetchLaws = async () => {
    try {
      const n = await invoke<number>("fetch_laws");
      say(`Открываю форум: скачиваю ${n} законов…`);
    } catch (e) {
      say(String(e));
    }
  };
  const lawCount = useMemo(() => docs.filter((d) => !isRules(d)).length, [docs]);
  const noLaws = kind === "laws" && lawCount === 0;

  const openForum = (url?: string) => invoke("open_forum", { url: url ?? null }).catch((e) => say(String(e)));

  // клавиатура
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        runAi();
        return;
      }
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        toggleVoice();
        return;
      }
      if (e.key === "Escape" && voice === "listening") {
        e.preventDefault();
        voiceRef.current?.cancel();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (view.kind !== "home") setView({ kind: "home" });
        else if (query) setQuery("");
        else invoke("hide_main");
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && view.kind !== "notes") {
        // Tab: всё → правила → законы → всё
        e.preventDefault();
        setKind((k) => (k === null ? "rules" : k === "rules" ? "laws" : null));
        if (view.kind !== "home" && view.kind !== "doc") setView({ kind: "home" });
        searchRef.current?.focus();
        return;
      }
      if (e.ctrlKey && (e.code === "Equal" || e.code === "NumpadAdd")) {
        e.preventDefault();
        return scaleRef.current((settings?.scale || 1) + 0.1);
      }
      if (e.ctrlKey && (e.code === "Minus" || e.code === "NumpadSubtract")) {
        e.preventDefault();
        return scaleRef.current((settings?.scale || 1) - 0.1);
      }
      if (e.ctrlKey && (e.code === "Digit0" || e.code === "Numpad0")) {
        e.preventDefault();
        return scaleRef.current(1);
      }
      if (e.altKey && e.key === "ArrowLeft") return goBack();
      if (e.altKey && e.key === "ArrowRight") return goFwd();
      if (e.ctrlKey && e.code === "KeyF") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (e.ctrlKey && e.code === "KeyP") {
        e.preventDefault();
        togglePin();
        return;
      }
      if (e.ctrlKey && e.code === "KeyH") {
        e.preventDefault();
        return void invoke("toggle_history").catch(() => {});
      }
      if (e.ctrlKey && e.code === "KeyO") {
        e.preventDefault();
        const url = curDoc?.url ?? hits[sel]?.doc.url;
        if (url) openUrl(url);
        return;
      }
      if (e.ctrlKey && e.code === "KeyC") {
        const inp = searchRef.current;
        const textSelected =
          !!window.getSelection()?.toString() || (!!inp && document.activeElement === inp && inp.selectionStart !== inp.selectionEnd);
        if (textSelected) return;
        if (view.kind === "doc" && curDoc && view.point != null && curPoints[view.point]) {
          e.preventDefault();
          copyPoint(curPoints[view.point], curDoc);
        } else if (view.kind === "home" && hits[sel]) {
          e.preventDefault();
          copyPoint(hits[sel].p, hits[sel].doc);
        }
        return;
      }
      if (view.kind === "notes") return; // в заметках стрелки и Enter нужны для текста
      if (view.kind === "home" && hits.length) {
        if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
        if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
        if (e.key === "Enter") { const h = hits[sel]; openPoint(h.doc, h.p); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    document.querySelector(".hit.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  useEffect(() => {
    if (view.kind === "doc" && view.point != null) {
      requestAnimationFrame(() => document.getElementById(`pt-${view.point}`)?.scrollIntoView({ block: "center" }));
    } else document.querySelector(".panel-body")?.scrollTo(0, 0);
  }, [view]);

  return (
    <div className={`shell ${expanded ? "" : "mini"}`} data-tauri-drag-region>
      <div
        className="bar"
        data-tauri-drag-region
        onMouseDown={(e) => {
          // клик по пустому месту строки ставит курсор в поиск — не надо целиться в поле
          if (e.target === e.currentTarget) searchRef.current?.focus();
        }}
      >
        <button
          className={`logo ${pinned ? "pinned" : ""}`}
          title={pinned ? "Открепить (Ctrl+P)" : "Закрепить поверх игры (Ctrl+P): хелпер висит, а ты двигаешься в игре"}
          onClick={togglePin}
        >
          <img src={logoUrl} className="logo-mark" alt="" draggable={false} />
          <span className="logo-pin">
            <svg viewBox="0 0 24 24"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
          </span>
        </button>
        <input
          ref={searchRef}
          autoFocus
          className="q"
          value={query}
          spellCheck={false}
          placeholder={kind === "rules" ? "Пункт или нарушение" : kind === "laws" ? "Статья или номер" : "Пункт, статья или ситуация"}
          onChange={(e) => {
            setQuery(e.target.value);
            if (view.kind !== "home") setView({ kind: "home" });
          }}
        />
        <button
          className={`mic ${voice}`}
          title={voice === "listening" ? "Слушаю — договори, остановится само (Esc — отмена)" : voice === "processing" ? "Распознаю…" : "Сказать голосом (Ctrl+Пробел)"}
          onClick={toggleVoice}
        >
          {voice === "processing" ? <span className="spinner" /> : Icon.mic}
        </button>
        {query && (
          <button className="clear" title="Очистить (Esc)" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>✕</button>
        )}
        {crawl?.active && <div className="spinner" title={`Собираю с форума: осталось ${crawl.left}`} />}
        {update && (
          <button
            className="upd"
            title="Скачать и установить новую версию"
            onClick={() => {
              say("Обновляю… программа перезапустится");
              invoke("install_update").catch((e) => say(String(e)));
            }}
          >
            Обновить до {update}
          </button>
        )}
        {settings && settings.showPromo !== false && (
          <button
            className="promo"
            title={`Скопировать /promo ${PROMO}`}
            onClick={async () => {
              const cmd = `/promo ${PROMO}`;
              try {
                await navigator.clipboard.writeText(cmd);
                say(`Скопировано: ${cmd}`);
              } catch {
                say("Не удалось скопировать");
              }
            }}
          >
            <svg viewBox="0 0 24 24" className="promo-ic"><path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8 3a2 2 0 0 0 0 4M12 7s1.5-4 4-4a2 2 0 0 1 0 4" /></svg>
            <span className="promo-cmd">/promo</span>
            <span className="promo-code">{PROMO.toUpperCase()}</span>
          </button>
        )}
        <div className="seg" title="Где искать (Tab)">
          <button className={kind === "rules" ? "on" : ""} onClick={() => setKind(kind === "rules" ? null : "rules")}>Правила</button>
          <button className={kind === "laws" ? "on" : ""} onClick={() => setKind(kind === "laws" ? null : "laws")}>Законы</button>
        </div>
        <div className="sep" />
        <button className={`ib ${view.kind === "notes" ? "on" : ""}`} title="Заметки" onClick={() => toggle("notes")}>{Icon.note}<span className="cap">Заметки</span></button>
        <button className={`ib ${view.kind === "catalog" ? "on" : ""}`} title="Каталог: транспорт, одежда, причёски, предметы" onClick={() => toggle("catalog")}>{Icon.shop}<span className="cap">Каталог</span></button>
        <button className={`ib ${view.kind === "library" ? "on" : ""}`} title="Все документы" onClick={() => toggle("library")}>{Icon.book}<span className="cap">Документы</span></button>
        <button className="ib" title="История (Ctrl+H) — откроется справа" onClick={() => invoke("toggle_history").catch(() => {})}>
          {Icon.history}
          <span className="cap">История</span>
          {changed.length > 0 && <span className="dot" />}
        </button>
        <button className={`ib ${view.kind === "settings" ? "on" : ""}`} title="Настройки" onClick={() => toggle("settings")}>{Icon.gear}<span className="cap">Настройки</span></button>
        {!expanded && settings?.showCredit !== false && <Credit say={say} className="credit-tab" />}
      </div>

      {expanded && (
        <div className="panel">
          {view.kind !== "home" && (
            <div className="panel-nav">
              <button className="link" title="Назад (Alt+←, Esc)" onClick={goBack}>‹ Назад</button>
              {fwd.length > 0 && <button className="link" title="Вперёд (Alt+→)" onClick={goFwd}>Вперёд ›</button>}
            </div>
          )}
          <div className="panel-body">
            {view.kind === "home" && docs.length > 0 && query.trim().length >= 3 && (
              <div className={`ai ${ai ? "has" : ""}`}>
                {!ai && (
                  <button className="ai-ask" onClick={runAi} disabled={aiBusy}>
                    <span className="ai-spark">✦</span>
                    {aiBusy ? "ИИ думает…" : <>Спросить ИИ: «{query.trim().slice(0, 60)}»</>}
                    <span className="ai-kbd"><kbd>Ctrl</kbd><kbd>Enter</kbd></span>
                  </button>
                )}
                {ai && (
                  <>
                    <div className="ai-head">
                      <span className="ai-spark">✦</span> Ответ ИИ
                      <span className="muted small">{ai.left != null ? `· осталось ${ai.left} на сегодня` : ""}</span>
                      <span className="grow" />
                      <button className="ai-btn" title="Скопировать" onClick={async () => { await navigator.clipboard.writeText(ai.answer); say("Ответ скопирован"); }}>⧉</button>
                    </div>
                    <div className="ai-text">{ai.answer}</div>
                    <div className="muted small">ИИ может ошибаться — сверяйся со статьями ниже.</div>
                  </>
                )}
              </div>
            )}

            {view.kind === "home" &&
              (docs.length === 0 ? (
                <Empty onForum={() => openForum()} onLaws={fetchLaws} />
              ) : noLaws ? (
                <div className="empty">
                  <h2>Законов пока нет</h2>
                  <p className="muted">Правила уже есть. Законы штата (УК, АК, ПК, Конституция и ещё 17) программа скачает с форума сама. Откроется окно форума, ничего нажимать не нужно.</p>
                  <button className="btn primary" onClick={fetchLaws}>Скачать законы</button>
                </div>
              ) : hits.length || noteHits.length ? (
                <>
                  {noteHits.length > 0 && (
                    <div className="hits note-hits">
                      {noteHits.map((n) => (
                        <div key={n.id} className="hit" onClick={() => openNote(n.id)}>
                          <div className="hit-head">
                            <span className="kind n">Заметка</span>
                            <span className="hit-doc">{n.title || "Без названия"}</span>
                          </div>
                          <div className="hit-text"><Highlight text={snippet(n.text, query)} query={query} /></div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="hits-head">
                    <span>{hits.length >= 150 ? "150+" : hits.length} {plural(hits.length, "совпадение", "совпадения", "совпадений")}</span>
                    {res.fixed && <span className="fixed">Раскладка исправлена: «{res.fixed}»</span>}
                    {res.wide && <span className="fixed">В разделе «{kind === "rules" ? "Правила" : "Законы"}» точно не нашлось — ищу везде</span>}
                    {res.loose && <span className="fixed">Точных совпадений нет — показываю похожие</span>}
                  </div>
                  <div className="hits">
                    {hits.map((h, i) => {
                      const pun = punishment(h.p.text);
                      return (
                        <div key={h.p.key} className={`hit ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => openPoint(h.doc, h.p)}>
                          <div className="hit-head">
                            {h.p.num && <span className="num">{h.p.num}</span>}
                            <span className={`kind ${isRules(h.doc) ? "r" : "l"}`}>{isRules(h.doc) ? "Правила" : "Закон"}</span>
                            <span className="hit-doc">{h.doc.title}</span>
                            <button className="copy" title="Скопировать пункт (Ctrl+C)" onClick={(e) => { e.stopPropagation(); copyPoint(h.p, h.doc); }}>⧉</button>
                          </div>
                          {res.exact ? (
                            <div className="hit-text full">{h.p.text}</div>
                          ) : (
                            <div className="hit-text"><Highlight text={snippet(h.p.text, hlQuery)} query={hlQuery} /></div>
                          )}
                          {pun && <div className="pun"><b>Наказание</b>{pun}</div>}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="nothing">
                  <div className="nothing-t">Похожих пунктов нет</div>
                  {kind ? <>Ищу только в разделе «{kind === "rules" ? "Правила" : "Законы"}». Tab — искать везде.</> : "Попробуй другое слово, короче фразу или номер пункта."}
                </div>
              ))}

            {view.kind === "doc" && curDoc && (
              <article className="doc">
                <div className="doc-head">
                  <div>
                    <div className="doc-section">{curDoc.section}</div>
                    <h1>{curDoc.title}</h1>
                    <div className="doc-meta">Обновлено {fmtDate(curDoc.fetchedAt)} · клик по пункту копирует его</div>
                  </div>
                  <button className="btn" title="Открыть на форуме (Ctrl+O)" onClick={() => openUrl(curDoc.url)}>На форуме ↗</button>
                </div>
                {curPoints.map((p, i) => {
                  const pun = p.num ? punishment(p.text) : null;
                  return (
                  <div key={p.key}>
                    {p.chapter && p.chapter !== curPoints[i - 1]?.chapter && <h2 className="chapter">{p.chapter}</h2>}
                    <div
                      id={`pt-${p.idx}`}
                      className={`pt ${p.num ? "" : "intro"} ${view.point === p.idx ? "sel" : ""}`}
                      onClick={() => {
                        if (window.getSelection()?.toString()) return;
                        setView({ ...view, point: p.idx });
                        if (settings?.copyOnClick && p.num) copyPoint(p, curDoc);
                      }}
                    >
                      {p.num && <span className="num">{p.num}</span>}
                      <div className="pt-body">
                        <div className="pt-text">{p.text}</div>
                        {pun && <div className="pun"><b>Наказание</b>{pun}</div>}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </article>
            )}

            {view.kind === "notes" && (
              <NotesView
                notes={notes}
                cur={noteId}
                onSelect={setNoteId}
                onChange={setNotes}
                onCopy={async (t) => { await navigator.clipboard.writeText(t); say("Заметка скопирована"); }}
              />
            )}


            {view.kind === "catalog" && (
              <Catalog onCopy={async (t, what) => { try { await navigator.clipboard.writeText(t); say(`${what} скопировано: ${t}`); } catch { say("Не удалось скопировать"); } }} />
            )}

            {view.kind === "library" &&
              (docs.length ? (
                <DocList docs={filtered} onOpen={(id) => go({ kind: "doc", id })} onForum={() => openForum()} />
              ) : (
                <Empty onForum={() => openForum()} onLaws={fetchLaws} />
              ))}

            {view.kind === "history" && (
              <>
                <h1 className="h">История</h1>
                {recent.length === 0 ? (
                  <div className="muted pad">Здесь будут пункты, которые ты открывал.</div>
                ) : (
                  <div className="hits">
                    {recent.map((r) => {
                      const d = docs.find((x) => x.id === r.docId);
                      const p = d && parsePoints(d.id, d.text).find((x) => x.num === r.num);
                      if (!d || !p) return null;
                      return (
                        <div key={r.docId + r.num} className="hit" onClick={() => go({ kind: "doc", id: d.id, point: p.idx })}>
                          <div className="hit-head">
                            <span className="num">{p.num}</span>
                            <span className="hit-doc">{d.title}</span>
                          </div>
                          <div className="hit-text">{snippet(p.text, "", 160)}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <Changes docs={changed} onOpen={(id) => go({ kind: "doc", id })} onClear={() => invoke("clear_changes").then(loadDocs)} />
              </>
            )}

            {view.kind === "settings" && settings && (
              <SettingsView
                s={settings}
                docs={docs}
                onChange={async (next) => {
                  try {
                    const { autostart, ...rest } = next;
                    if (autostart !== settings.autostart) await invoke("set_autostart", { on: autostart });
                    await invoke("set_settings", { settings: rest });
                    setSettings(next);
                  } catch (e) {
                    say(String(e));
                    loadSettings();
                  }
                }}
                onForum={() => openForum()}
                onSync={syncAll}
                onLaws={fetchLaws}
                onDelete={(id) => invoke("delete_doc", { id }).then(loadDocs)}
              />
            )}
          </div>
          {(settings?.showCredit !== false || (view.kind === "home" && hits.length > 0)) && (
            <div className="foot">
              {settings?.showCredit !== false && <Credit say={say} className="credit" />}
              {view.kind === "home" && hits.length > 0 && (<>
                <span><kbd>↑</kbd><kbd>↓</kbd> выбрать</span>
                <span><kbd>Enter</kbd> открыть</span>
                <span><kbd>Ctrl</kbd><kbd>C</kbd> копировать</span>
                <span><kbd>Tab</kbd> правила / законы</span>
                <span><kbd>Esc</kbd> очистить</span>
                <span><kbd>Ctrl</kbd><kbd>Пробел</kbd> голосом</span>
                <span><kbd>Ctrl</kbd><kbd>Enter</kbd> спросить ИИ</span>
              </>)}
            </div>
          )}
          {toast && <div className="toast">{toast}</div>}
        </div>
      )}
      {!expanded && toast && <div className="toast mini">{toast}</div>}
    </div>
  );
}

function NotesView({
  notes, cur, onSelect, onChange, onCopy,
}: {
  notes: Note[]; cur: string | null; onSelect: (id: string | null) => void; onChange: (n: Note[]) => void; onCopy: (t: string) => void;
}) {
  const sorted = useMemo(() => notes.slice().sort((a, b) => b.at - a.at), [notes]);
  const note = notes.find((n) => n.id === cur) ?? sorted[0];
  const add = () => {
    const n = { id: Date.now().toString(36), title: "", text: "", at: Date.now() };
    onChange([n, ...notes]);
    onSelect(n.id);
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".note-title")?.focus());
  };
  const patch = (p: Partial<Note>) => note && onChange(notes.map((n) => (n.id === note.id ? { ...n, ...p, at: Date.now() } : n)));
  return (
    <div className="notes">
      <div className="notes-list">
        <button className="btn primary" onClick={add}>+ Новая заметка</button>
        {sorted.map((n) => (
          <button key={n.id} className={`note-item ${note?.id === n.id ? "on" : ""}`} onClick={() => onSelect(n.id)}>
            <span className="note-item-t">{n.title || "Без названия"}</span>
            <span className="note-item-s">{n.text.split("\n")[0] || "Пусто"}</span>
          </button>
        ))}
      </div>
      {note ? (
        <div className="note-edit">
          <div className="note-bar">
            <input className="note-title" placeholder="Название" value={note.title} onChange={(e) => patch({ title: e.target.value })} />
            <button className="btn" onClick={() => onCopy(note.text)} title="Скопировать текст заметки">Копировать</button>
            <button className="btn" onClick={() => { onChange(notes.filter((n) => n.id !== note.id)); onSelect(null); }}>Удалить</button>
          </div>
          <textarea
            className="note-text"
            placeholder="Отыгровки, бинды, номера статей — что угодно. Сохраняется само."
            value={note.text}
            onChange={(e) => patch({ text: e.target.value })}
          />
        </div>
      ) : (
        <div className="nothing">
          <div className="nothing-t">Заметок пока нет</div>
          Создай первую: отыгровки, бинды, частые статьи. Они ищутся вместе с правилами.
        </div>
      )}
    </div>
  );
}

const FEEDBACK_URL = "https://voice-production-39e0.up.railway.app/feedback";

function Feedback() {
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState("");
  async function send() {
    setErr("");
    setState("sending");
    try {
      const version = await getVersion().catch(() => "");
      const r = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-Id": clientId() },
        body: JSON.stringify({ rating, text, contact, version }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Не получилось отправить");
      setState("sent");
      setText("");
    } catch (e) {
      setErr(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Нет связи с сервером");
      setState("idle");
    }
  }
  if (state === "sent")
    return (
      <div className="card fb-done">
        <b>Спасибо за отзыв!</b> Он уже у автора.
        <button className="link" onClick={() => setState("idle")}>Написать ещё</button>
      </div>
    );
  return (
    <div className="card fb">
      <div className="fb-stars" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={(hover || rating) >= n ? "on" : ""} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)} title={`${n} из 5`}>
            ★
          </button>
        ))}
        <span className="muted small">Что нравится, что сломалось, чего не хватает?</span>
      </div>
      <textarea className="fb-text" placeholder="Твой отзыв…" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
      <div className="fb-row">
        <input className="fb-contact" placeholder="Как с тобой связаться (необязательно): ник, Telegram, Discord" value={contact} maxLength={100} onChange={(e) => setContact(e.target.value)} />
        <button className="btn primary" disabled={state === "sending" || text.trim().length < 3} onClick={send}>
          {state === "sending" ? "Отправляю…" : "Отправить"}
        </button>
      </div>
      {err && <div className="fb-err">{err}</div>}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function Empty({ onForum, onLaws }: { onForum: () => void; onLaws: () => void }) {
  return (
    <div className="empty">
      <h2>База пока пустая</h2>
      <p className="muted">Обычно правила и законы подтягиваются сами через несколько секунд после запуска. Если нет интернета до GitHub, скачай их с форума.</p>
      <div className="btns center">
        <button className="btn primary" onClick={onLaws}>Скачать законы</button>
        <button className="btn" onClick={onForum}>Открыть форум</button>
      </div>
    </div>
  );
}

function DocList({ docs, onOpen, onForum }: { docs: Doc[]; onOpen: (id: string) => void; onForum: () => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Doc[]>();
    for (const d of docs) m.set(d.section, [...(m.get(d.section) ?? []), d]);
    for (const v of m.values()) v.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru"));
  }, [docs]);
  return (
    <div className="groups">
      <div className="lib-head">
        <h1 className="h">Документы · {docs.length}</h1>
        <button className="btn" onClick={onForum}>Добавить с форума</button>
      </div>
      {groups.map(([sec, list]) => (
        <section key={sec}>
          <h3 className="group-title">{sec}</h3>
          <div className="doc-grid">
            {list.map((d) => (
              <button key={d.id} className="doc-card" onClick={() => onOpen(d.id)}>
                <span className="doc-card-title">{d.title}</span>
                <span className="doc-card-meta">
                  {parsePoints(d.id, d.text).filter((p) => p.num).length} пунктов
                  {d.changedAt ? <em> · изменён {fmtDate(d.changedAt)}</em> : null}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Changes({ docs, onOpen, onClear }: { docs: Doc[]; onOpen: (id: string) => void; onClear: () => void }) {
  if (!docs.length)
    return (
      <div className="muted pad">
        Изменений нет. Когда обновишь законы (Настройки → «Обновить все»), здесь появится, что добавили, убрали и поменяли.
      </div>
    );
  return (
    <div className="changes">
      <div className="changes-head">
        <h1 className="h">Последние изменения</h1>
        <button className="btn" onClick={onClear}>Отметить прочитанным</button>
      </div>
      {docs
        .slice()
        .sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0))
        .map((d) => {
          const ch = diffDoc(d);
          return (
            <section key={d.id} className="change-doc">
              <button className="change-title" onClick={() => onOpen(d.id)}>
                {d.title} <span>· {fmtDate(d.changedAt)}</span>
              </button>
              {ch.length === 0 && <div className="muted">Поменялось оформление, пункты те же.</div>}
              {ch.slice(0, 60).map((c, i) => (
                <div key={i} className={`change ${c.kind}`}>
                  <span className="tag">{c.kind === "added" ? "новое" : c.kind === "removed" ? "убрано" : "изменено"}</span>
                  <span className="num">{c.num.startsWith("#") ? "текст" : c.num}</span>
                  <div className="change-body">
                    {c.before && c.kind === "changed" && <div className="was"><b>было:</b> {c.before}</div>}
                    {c.kind === "removed" && <div className="was">{c.before}</div>}
                    {c.after && <div className="now">{c.kind === "changed" && <b>стало: </b>}{c.after}</div>}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
    </div>
  );
}

// Политика конфиденциальности: пишем только то, что программа делает на самом деле.
const PRIVACY: { t: string; d: string }[] = [
  { t: "Не вмешивается в игру", d: "Без инжектов и DLL. Программа не читает память игры, не меняет её файлы и ничего не нажимает за тебя. Это обычное отдельное окно поверх игры." },
  { t: "Не нужен аккаунт", d: "Без логинов и паролей. Доступа к твоему аккаунту в игре, Discord или Windows у программы нет." },
  { t: "Что хранится на компьютере", d: "Настройки, база правил и законов, история поиска, заметки и случайный номер установки. Всё лежит только у тебя и удаляется вместе с программой." },
  { t: "Голосовой поиск", d: "Микрофон включается, только когда ты сам нажимаешь кнопку или Ctrl+Пробел. Запись отправляется на сервер Trace Helper, превращается в текст и не сохраняется." },
  { t: "Вопросы ИИ", d: "Текст вопроса и найденные статьи отправляются на сервер Trace Helper и к нейросети, чтобы получить ответ. Вопросы не сохраняются." },
  { t: "Отзывы", d: "Отзыв, оценка, версия программы и контакт (если ты его указал) приходят автору в Telegram." },
  { t: "Лимиты", d: "Чтобы никто не тратил весь лимит, сервер считает запросы за день по номеру установки и IP. Счётчики хранятся только в памяти и обнуляются." },
  { t: "Сеть", d: "Ещё программа скачивает обновления и общую базу с GitHub, а свежие законы — с форума Trace RP. Рекламы, трекеров и продажи данных нет." },
];

function Privacy() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card privacy">
      <div className="row clickable" onClick={() => setOpen(!open)}>
        <div>
          <div>Политика конфиденциальности</div>
          <div className="muted small">Программа не вмешивается в игру и не собирает личные данные</div>
        </div>
        <span className="muted">{open ? "Скрыть" : "Подробнее"}</span>
      </div>
      {open && (
        <div className="privacy-list">
          {PRIVACY.map((p) => (
            <div key={p.t} className="privacy-item">
              <b>{p.t}</b>
              <div className="muted small">{p.d}</div>
            </div>
          ))}
          <div className="muted small">Вопросы — автору: @f1losovsky или через «Отзыв» выше.</div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="row clickable" onClick={() => onChange(!on)}>
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <span className={`switch ${on ? "on" : ""}`}><span /></span>
    </div>
  );
}

function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  const map: Record<string, string> = { Backquote: "`", Space: "Space", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Pause: "Pause" };
  return map[c] ?? null;
}

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  useEffect(() => {
    if (!rec) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRec(false);
      const k = keyName(e);
      if (!k) return;
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
      if (!mods.length && !/^F\d/.test(k)) return; // одиночную букву не даём — будет мешать в игре
      setRec(false);
      onChange([...mods, k].join("+"));
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [rec, onChange]);
  return (
    <button className={`hotkey ${rec ? "rec" : ""}`} onClick={() => setRec(true)}>
      {rec ? "Нажми сочетание…" : value}
    </button>
  );
}

function SettingsView({
  s, docs, onChange, onSync, onLaws, onDelete,
}: {
  s: Settings; docs: Doc[]; onChange: (s: Settings) => void; onForum: () => void; onSync: () => void; onLaws: () => void; onDelete: (id: string) => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...s, ...patch });
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <div className="settings">
      <h1 className="h">Настройки</h1>

      <h3>Отзыв</h3>
      <Feedback />

      <h3>Основное</h3>
      <div className="card">
        <Toggle label="Поверх всех окон" hint="Окно остаётся над игрой" on={s.alwaysOnTop} onChange={(v) => set({ alwaysOnTop: v })} />
        <Toggle label="Режим стримера" hint="Окна не видно в OBS, Discord и на скриншотах" on={s.streamerMode} onChange={(v) => set({ streamerMode: v })} />
        <Toggle label="Прятать, когда переключаюсь в игру" hint="Выключено: окно висит, пока не нажмёшь Alt+Q или Esc" on={s.hideOnBlur} onChange={(v) => set({ hideOnBlur: v })} />
        <Toggle label="Копировать пункт по клику" on={s.copyOnClick} onChange={(v) => set({ copyOnClick: v })} />
        <Toggle label="Запускать вместе с Windows" hint="Стартует свёрнутым в трей" on={s.autostart} onChange={(v) => set({ autostart: v })} />
        <Toggle label="Автообновление" hint="Выключено: новая версия не ставится сама, в строке появится кнопка «Обновить»" on={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
        <Toggle label="Голос в игре (Ctrl+Пробел)" hint="Жмёшь в игре, говоришь — справа появляется статья и история запросов. Игра остаётся активной" on={s.voiceOverlay} onChange={(v) => set({ voiceOverlay: v })} />
      </div>

      <h3>Плашки</h3>
      <div className="card">
        <Toggle label="Подпись автора" hint="created by filosov и контакты под строкой поиска" on={s.showCredit !== false} onChange={(v) => set({ showCredit: v })} />
        <Toggle label="Плашка промокода" hint="Кнопка «/promo FILOSOV» в строке. Выключено — её не будет" on={s.showPromo !== false} onChange={(v) => set({ showPromo: v })} />
      </div>

      <h3>Размер</h3>
      <div className="card">
        <div className="row">
          <div>
            <div>Размер окна</div>
            <div className="muted small">Также Ctrl+колесо мыши или Ctrl+плюс / минус, Ctrl+0 — обычный</div>
          </div>
          <div className="btns scale-btns">
            <button className="btn" disabled={(s.scale || 1) <= 0.7} onClick={() => set({ scale: clampScale((s.scale || 1) - 0.1) })}>−</button>
            <span className="scale-val">{Math.round((s.scale || 1) * 100)}%</span>
            <button className="btn" disabled={(s.scale || 1) >= 1.5} onClick={() => set({ scale: clampScale((s.scale || 1) + 0.1) })}>+</button>
          </div>
        </div>
      </div>

      <h3>Клавиши</h3>
      <div className="card">
        <div className="row">
          <div>
            <div>Открыть / спрятать окно</div>
            <div className="muted small">Работает и в игре. Игра должна быть в режиме «Оконный без рамки».</div>
          </div>
          <HotkeyInput value={s.hotkey} onChange={(v) => set({ hotkey: v })} />
        </div>
        <div className="keys muted small">
          Esc — назад / очистить / спрятать · Ctrl+Пробел — сказать голосом · Ctrl+Enter — спросить ИИ · Ctrl+колесо — размер окна · Tab — правила / законы / всё · Ctrl+F — поиск · Ctrl+C — скопировать пункт · Ctrl+O — открыть на форуме · Alt+← → — назад и вперёд
        </div>
      </div>

      <h3>Правила и законы</h3>
      <div className="card">
        <div className="row">
          <div>
            <div>Документов: {docs.length} · законов: {docs.filter((d) => !isRules(d)).length}</div>
            <div className="muted small">Общая база обновляется сама раз в час. Свежее с форума — кнопками справа.</div>
          </div>
          <div className="btns">
            <button className="btn" onClick={onLaws}>Скачать законы</button>
            <button className="btn primary" disabled={!docs.length} onClick={onSync}>Обновить все</button>
          </div>
        </div>
        {docs.length > 0 && (
          <div className="doc-rows">
            {docs
              .slice()
              .sort((a, b) => a.section.localeCompare(b.section, "ru") || a.title.localeCompare(b.title, "ru"))
              .map((d) => (
                <div key={d.id} className="doc-row">
                  <span className="muted small">{d.section}</span>
                  <span className="grow">{d.title}</span>
                  <span className="muted small">{fmtDate(d.fetchedAt)}</span>
                  <button className="ib small" title="Убрать из программы" onClick={() => onDelete(d.id)}>✕</button>
                </div>
              ))}
          </div>
        )}
      </div>

      <h3>Конфиденциальность</h3>
      <Privacy />

      <h3>Программа</h3>
      <div className="card">
        <div className="row">
          <div>
            <div>Trace Helper {version}</div>
            <div className="muted small">от Филосов · @f1losovsky · правила и законы Trace RP поверх игры</div>
          </div>
          <button className="btn" onClick={() => invoke("quit")}>Выйти</button>
        </div>
        <UpdateRow />
      </div>
    </div>
  );
}

/** Проверка обновления вручную: видно, есть ли новая версия, и ошибку, если что-то не так. */
function UpdateRow() {
  const [st, setSt] = useState<{ kind: "idle" | "busy" | "new" | "ok" | "err"; text: string; ver?: string }>({ kind: "idle", text: "" });
  const check = () => {
    setSt({ kind: "busy", text: "Проверяю…" });
    invoke<string | null>("check_update")
      .then((v) => setSt(v ? { kind: "new", text: `Есть новая версия ${v}`, ver: v } : { kind: "ok", text: "У тебя последняя версия" }))
      .catch((e) => setSt({ kind: "err", text: `Не удалось проверить: ${e}` }));
  };
  const install = () => {
    setSt({ kind: "busy", text: "Скачиваю и ставлю… программа перезапустится сама" });
    invoke("install_update").catch((e) => setSt({ kind: "err", text: String(e) }));
  };
  return (
    <div className="row">
      <div>
        <div>Обновления</div>
        <div className={`small ${st.kind === "err" ? "err-text" : "muted"}`}>{st.text || "Проверяются сами каждые 15 минут"}</div>
      </div>
      {st.kind === "new" ? (
        <button className="btn primary" onClick={install}>Обновить до {st.ver}</button>
      ) : (
        <button className="btn" disabled={st.kind === "busy"} onClick={check}>Проверить обновления</button>
      )}
    </div>
  );
}

function Credit({ say, className }: { say: (t: string) => void; className: string }) {
  return (
    <div className={className}>
      created by <b>filosov</b>
      <i>|</i>
      <button className="credit-link" title="Скопировать ник в Discord" onClick={async () => { await navigator.clipboard.writeText("f1losovsky"); say("Discord скопирован: f1losovsky"); }}>Discord — f1losovsky</button>
      <i>|</i>
      <button className="credit-link" title="Открыть Telegram" onClick={() => openUrl("https://t.me/filosovsky").catch(() => {})}>Telegram — filosovsky</button>
    </div>
  );
}
