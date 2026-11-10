// Вопросы к ИИ: хелпер сам находит подходящие пункты в базе и отправляет их вместе с вопросом.
import { Doc, search } from "./law";
import { clientId } from "./voice";

const ASK_URL = "https://voice-production-39e0.up.railway.app/ask";

export type AiAnswer = { question: string; answer: string; left?: number };

const cleanDoc = (t: string) => t.replace(/^ИНФОРМАЦИЯ\s*/i, "").trim();

export async function askAi(docs: Doc[], question: string): Promise<AiAnswer> {
  // лучшие совпадения по всей базе — и правила, и законы
  const hits = search(docs, question, 40).hits.slice(0, 8);
  const context = hits.map((h) => ({ doc: cleanDoc(h.doc.title), num: h.p.num, text: h.p.text }));
  let r: Response;
  try {
    r = await fetch(ASK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-Id": clientId() },
      body: JSON.stringify({ question, context }),
    });
  } catch {
    throw new Error("Нет связи с сервером");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "ИИ не ответил");
  const answer = String(j.answer || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
  return { question, answer, left: j.left };
}
