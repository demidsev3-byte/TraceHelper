// Сервер Trace Helper: голосовой ввод (Whisper), вопросы к ИИ по базе законов и отзывы (в Telegram автору).
// Ключи живут только в переменных Railway, в программу они не попадают.

const GROQ_KEY = Bun.env.GROQ_API_KEY || "";
const OPENAI_KEY = Bun.env.OPENAI_API_KEY || "";
const DEEPSEEK_KEY = Bun.env.DEEPSEEK_API_KEY || "";
const TG_TOKEN = Bun.env.TG_BOT_TOKEN || "";
const TG_CHAT = Bun.env.TG_CHAT_ID || "";
const STT_PER_DAY = Number(Bun.env.STT_PER_DAY || 150); // на одного пользователя
const IP_PER_DAY = Number(Bun.env.IP_PER_DAY || 400); // на один адрес
const ASK_PER_DAY = Number(Bun.env.ASK_PER_DAY || (DEEPSEEK_KEY ? 50 : 10)); // вопросов к ИИ на одного пользователя
const FEEDBACK_PER_DAY = Number(Bun.env.FEEDBACK_PER_DAY || 5);
const MAX_AUDIO = 3 * 1024 * 1024; // около минуты речи

// ИИ: DeepSeek, если есть ключ (большой контекст — кодексы целиком), иначе Groq (только выдержки)
const AI = DEEPSEEK_KEY
  ? { name: "deepseek", url: "https://api.deepseek.com/chat/completions", key: DEEPSEEK_KEY, model: Bun.env.AI_MODEL || "deepseek-chat", snips: 20000, full: true }
  : { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: GROQ_KEY, model: Bun.env.AI_MODEL || "openai/gpt-oss-120b", snips: 6000, full: false };

// Общая база правил и законов — та же, что скачивает программа
const BASE_URL = "https://github.com/demidsev3-byte/TraceHelper-releases/releases/download/base/base.json";
const FULL_DOCS = /уголовный кодекс|административный кодекс|дорожный кодекс/i; // эти документы ИИ получает целиком

// Подсказка для распознавания: слова, которые Whisper иначе путает
const PROMPT =
  "Trace RP, LSPD, LSSD, FIB, SANG, EMS, GOV, Weazel News, УК, АК, ПК, ПГО, ДК, статья, пункт, " +
  "госник, задержание, деморган, варн, розыск, звезды, адвокат, прокурор, ордер, Миранда, бодикам, ДМ, ДБ, РП, нонРП.";

const RULES = `Ты — помощник в Trace Helper для игроков GTA 5 RP-сервера Trace RP (штат Сан-Андреас).
Отвечаешь на вопросы о правилах сервера и законах штата.

Как отвечать:
- Опирайся ТОЛЬКО на тексты документов ниже и выдержки в сообщении. Не придумывай статьи, номера и наказания.
- Вопрос может быть разговорным («что будет если я убью человека», «можно ли стрелять в копа»). Пойми, о каком деянии речь, и найди подходящую статью сам.
- Если ответа в документах действительно нет, так и скажи: «В найденных статьях ответа нет», и предложи, как переформулировать запрос.
- Называй конкретные нормы: документ и номер статьи или пункта (например «УК ст. 6.2 ч. 1», «АК ст. 3.4»).
- Если есть наказание (срок, штраф, звёзды ★, деморган, варн), обязательно укажи его. Звёзды ★ в УК — уровень розыска.
- Если подходит несколько статей (например, убийство умышленное и по неосторожности), перечисли их кратко.
- Пиши по-русски, коротко и по делу: 2–6 предложений или короткий список. Без вступлений и без markdown-заголовков.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Client-Id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, obj: unknown) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

// Лимиты в памяти, сбрасываются раз в сутки
const counters = new Map<string, number>();
let day = new Date().toISOString().slice(0, 10);
function allow(key: string, limit: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    counters.clear();
    day = today;
  }
  const n = counters.get(key) || 0;
  if (n >= limit) return false;
  counters.set(key, n + 1);
  return true;
}
function refund(key: string) {
  const n = counters.get(key) || 0;
  if (n > 0) counters.set(key, n - 1);
}
const used = (key: string) => counters.get(key) || 0;

// Кодексы целиком, обновляются раз в час при очередном вопросе
let codes = "";
let codesAt = 0;
let codesNames: string[] = [];
async function getCodes(): Promise<string> {
  if (codes && Date.now() - codesAt < 3600_000) return codes;
  try {
    const r = await fetch(BASE_URL, { redirect: "follow" });
    if (!r.ok) throw new Error(`base ${r.status}`);
    const j: any = await r.json();
    const docs = (j.docs || []).filter((d: any) => FULL_DOCS.test(d.title || ""));
    if (docs.length) {
      codesNames = docs.map((d: any) => String(d.title).replace(/^ИНФОРМАЦИЯ\s*/i, "").trim());
      codes = docs
        .map((d: any) => `=== ${String(d.title).replace(/^ИНФОРМАЦИЯ\s*/i, "").trim()} ===\n${String(d.text).trim()}`)
        .join("\n\n");
      codesAt = Date.now();
    }
  } catch (e) {
    console.error("не скачалась база:", e);
    codesAt = Date.now() - 3000_000; // повторим через 10 минут
  }
  return codes;
}

async function transcribe(audio: ArrayBuffer, mime: string): Promise<string> {
  const useGroq = !!GROQ_KEY;
  const url = useGroq
    ? "https://api.groq.com/openai/v1/audio/transcriptions"
    : "https://api.openai.com/v1/audio/transcriptions";
  const ext = mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), `voice.${ext}`);
  form.append("model", useGroq ? "whisper-large-v3-turbo" : "whisper-1");
  form.append("language", "ru");
  form.append("prompt", PROMPT);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${useGroq ? GROQ_KEY : OPENAI_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return String(j.text || "").trim();
}

type Snip = { doc: string; num: string; text: string };

class Busy extends Error {}

const GROQ = { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: GROQ_KEY, model: "openai/gpt-oss-120b", snips: 6000, full: false };

// Если DeepSeek не ответил (нет денег на балансе, сбой) — пробуем Groq, чтобы ИИ не молчал
async function ask(question: string, snips: Snip[]): Promise<string> {
  if (AI.name === "groq" || !GROQ_KEY) return askWith(AI, question, snips);
  try {
    return await askWith(AI, question, snips);
  } catch (e) {
    console.error("deepseek не ответил, отвечает groq:", String(e).slice(0, 200));
    return askWith(GROQ, question, snips);
  }
}

async function askWith(AI: typeof GROQ, question: string, snips: Snip[]): Promise<string> {
  const full = AI.full ? await getCodes() : "";
  let ctx = "";
  for (const s of snips) {
    if (full && FULL_DOCS.test(s.doc)) continue; // этот кодекс и так целиком в начале
    const piece = `[${s.doc}${s.num ? ", " + s.num : ""}]\n${s.text.slice(0, 2000)}\n\n`;
    if (ctx.length + piece.length > AI.snips) break;
    ctx += piece;
  }
  // Кодексы — в системном сообщении: оно одинаковое у всех вопросов, DeepSeek его кэширует, и это почти бесплатно
  const system = full ? `${RULES}\n\nДокументы целиком:\n\n${full}` : RULES;
  const body: any = {
    model: AI.model,
    temperature: 0.2,
    max_tokens: 900,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Выдержки из других документов (правила и законы):\n\n${ctx || "(ничего не нашлось)"}\n---\nВопрос: ${question}` },
    ],
  };
  if (AI.model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
  const r = await fetch(AI.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${AI.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status === 402) throw new Busy(`${r.status} ${(await r.text()).slice(0, 200)}`);
  if (!r.ok) throw new Error(`ai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json();
  if (j.usage) console.log("ai usage", JSON.stringify(j.usage));
  return String(j.choices?.[0]?.message?.content || "").trim();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sendFeedback(f: { rating: number; text: string; contact: string; version: string; client: string }) {
  const stars = "★".repeat(f.rating) + "☆".repeat(5 - f.rating);
  const msg =
    `<b>Отзыв о Trace Helper</b>  ${stars}\n\n${esc(f.text)}\n\n` +
    (f.contact ? `Связь: ${esc(f.contact)}\n` : "") +
    `<i>версия ${esc(f.version || "?")} · id ${esc(f.client.slice(0, 8))}</i>`;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`tg ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

Bun.serve({
  port: Number(Bun.env.PORT || 8080),
  maxRequestBodySize: MAX_AUDIO + 1024,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && url.pathname === "/health")
      return json(200, {
        ok: true,
        stt: !!(GROQ_KEY || OPENAI_KEY),
        ai: !!AI.key,
        provider: AI.name,
        model: AI.model,
        codes: codesNames,
        feedback: !!(TG_TOKEN && TG_CHAT),
      });

    const client = (req.headers.get("x-client-id") || "").slice(0, 64);
    const ip = (req.headers.get("x-forwarded-for") || server.requestIP(req)?.address || "").split(",")[0].trim();

    if (req.method === "POST" && url.pathname === "/stt") {
      if (!GROQ_KEY && !OPENAI_KEY) return json(503, { error: "Голосовой ввод ещё не настроен" });
      if (!client) return json(400, { error: "Нет id клиента" });
      if (!allow("c:" + client, STT_PER_DAY) || !allow("ip:" + ip, IP_PER_DAY))
        return json(429, { error: "Лимит голосовых запросов на сегодня исчерпан" });
      try {
        const audio = await req.arrayBuffer();
        if (audio.byteLength < 1000) return json(400, { error: "Слишком короткая запись" });
        if (audio.byteLength > MAX_AUDIO) return json(413, { error: "Слишком длинная запись" });
        const text = await transcribe(audio, req.headers.get("content-type") || "audio/webm");
        return json(200, { text });
      } catch (e) {
        console.error(e);
        return json(502, { error: "Не получилось распознать, попробуй ещё раз" });
      }
    }

    if (req.method === "POST" && url.pathname === "/ask") {
      if (!AI.key) return json(503, { error: "ИИ ещё не настроен" });
      if (!client) return json(400, { error: "Нет id клиента" });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Плохой запрос" });
      }
      const question = String(body?.question || "").trim().slice(0, 500);
      if (question.length < 3) return json(400, { error: "Задай вопрос подробнее" });
      const snips: Snip[] = (Array.isArray(body?.context) ? body.context : [])
        .slice(0, 30)
        .map((s: any) => ({ doc: String(s?.doc || "").slice(0, 150), num: String(s?.num || "").slice(0, 20), text: String(s?.text || "") }));
      if (!allow("a:" + client, ASK_PER_DAY) || !allow("aip:" + ip, ASK_PER_DAY * 3))
        return json(429, { error: `Лимит ${ASK_PER_DAY} вопросов к ИИ на сегодня исчерпан. Поиск по правилам работает без ограничений.` });
      try {
        const answer = await ask(question, snips);
        if (!answer) throw new Error("empty answer");
        return json(200, { answer, left: Math.max(0, ASK_PER_DAY - used("a:" + client)) });
      } catch (e) {
        refund("a:" + client);
        refund("aip:" + ip);
        console.error(e);
        if (e instanceof Busy) return json(503, { error: "ИИ сейчас перегружен — попробуй через минуту. Если не поможет, общий лимит на сегодня закончился." });
        return json(502, { error: "ИИ не ответил, попробуй ещё раз" });
      }
    }

    if (req.method === "POST" && url.pathname === "/feedback") {
      if (!TG_TOKEN || !TG_CHAT) return json(503, { error: "Отзывы ещё не настроены" });
      if (!client) return json(400, { error: "Нет id клиента" });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "Плохой запрос" });
      }
      const text = String(body?.text || "").trim().slice(0, 2000);
      const rating = Math.max(1, Math.min(5, Math.round(Number(body?.rating) || 5)));
      if (text.length < 3) return json(400, { error: "Напиши хотя бы пару слов" });
      if (!allow("f:" + client, FEEDBACK_PER_DAY) || !allow("fip:" + ip, FEEDBACK_PER_DAY * 3))
        return json(429, { error: "Ты уже отправил много отзывов сегодня, спасибо!" });
      try {
        await sendFeedback({
          rating,
          text,
          contact: String(body?.contact || "").trim().slice(0, 100),
          version: String(body?.version || "").slice(0, 20),
          client,
        });
        return json(200, { ok: true });
      } catch (e) {
        console.error(e);
        return json(502, { error: "Не получилось отправить, попробуй позже" });
      }
    }

    return json(404, { error: "not found" });
  },
});
console.log("trace-helper server started, ai:", AI.name, AI.model);
