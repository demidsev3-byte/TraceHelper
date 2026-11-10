// Голосовой ввод: пишем микрофон, сами останавливаемся на тишине, отправляем на сервер Trace Helper.
const VOICE_URL = "https://voice-production-39e0.up.railway.app/stt";
const MAX_MS = 15000; // самое длинное сообщение
const SILENCE_MS = 1300; // столько тишины после речи — и запись заканчивается

export function clientId(): string {
  try {
    let id = localStorage.getItem("clientId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("clientId", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

export type VoiceSession = { stop: () => void; cancel: () => void };

/** Начать запись. onText — распознанный текст, onState — "listening" | "processing" | "idle". */
export async function startVoice(
  onText: (t: string) => void,
  onState: (s: "listening" | "processing" | "idle") => void,
  onError: (msg: string) => void,
): Promise<VoiceSession | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    onError("Нет доступа к микрофону: проверь, что он подключён и разрешён в Windows");
    return null;
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  let cancelled = false;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // тишину ловим по громкости
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const started = Date.now();
  let spoke = false;
  let lastLoud = Date.now();
  const timer = window.setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 6) {
      spoke = true;
      lastLoud = Date.now();
    }
    const now = Date.now();
    if ((spoke && now - lastLoud > SILENCE_MS) || now - started > MAX_MS) stop();
    if (!spoke && now - started > 6000) stop(); // так ничего и не сказал
  }, 100);

  function cleanup() {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }
  function stop() {
    if (rec.state !== "inactive") rec.stop();
  }

  rec.onstop = async () => {
    cleanup();
    if (cancelled) return onState("idle");
    if (!spoke) {
      onState("idle");
      return onError("Не слышно — проверь микрофон и скажи ещё раз");
    }
    onState("processing");
    try {
      const blob = new Blob(chunks, { type: mime.split(";")[0] });
      const r = await fetch(VOICE_URL, { method: "POST", headers: { "Content-Type": blob.type, "X-Client-Id": clientId() }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Сервер не ответил");
      const text = String(j.text || "").replace(/[.!?]+$/, "").trim();
      if (text) onText(text);
      else onError("Не расслышал — скажи ещё раз");
    } catch (e) {
      onError(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Нет связи с сервером");
    }
    onState("idle");
  };

  rec.start(250);
  onState("listening");
  return {
    stop,
    cancel: () => {
      cancelled = true;
      stop();
    },
  };
}
