// Встраивается в окно форума Trace RP. Добавляет панель «Добавить в Trace Helper»
// и при сборе обходит темы по очереди, передавая их текст в приложение.
(function () {
  if (window.top !== window || window.__fhLoaded) return;
  window.__fhLoaded = true;

  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  const DELAY = 1200;
  const LAW_RE = /закон|кодекс|правил|конституц|регламент|постановлен|указ|устав|норматив/i;
  // темы, которые забираем при «глубоком» обходе всего форума
  const DOC_RE = /закон|кодекс|конституц|постановлен|указ|устав|положени|регламент|правил|habeas|хабеас|норматив/i;
  // жалобы, заявки и прочие обращения пропускаем
  const SKIP_RE = /жалоб|обжалов|заявлен|заявк|апелляц|отч[её]т|обращени|предложени|вопрос|флуд|оффтоп|архив/i;
  const cleanTitle = (t) => t.replace(/^\s*((закрыто|закреплено|важно|решено|открыто|актуально)\s*)+/i, "").trim();

  function isChallenge() {
    return /traceguard|проверка браузера/i.test(document.title + " " + (document.body?.innerText || "").slice(0, 300));
  }
  const isThread = () => /\/threads\//.test(location.pathname) && !!document.querySelector("article.message");
  const isSection = () => /\/forums\//.test(location.pathname) && !!document.querySelector(".structItem--thread, .node-title");

  // Текст поста с переносами строк; спойлеры раскрываем, служебные кнопки пропускаем
  function toText(root) {
    const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TABLE|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|HR)$/;
    let out = "";
    (function walk(n) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|BUTTON)$/.test(t)) return;
      if (n.classList.contains("bbCodeBlock-expandLink") || n.classList.contains("js-selectToQuoteEnd")) return;
      if (t === "BR") { out += "\n"; return; }
      if (t === "IMG") { if (n.alt && !/^\W+$/.test(n.alt) && n.classList.contains("smilie")) out += n.alt; return; }
      if (t === "TD" || t === "TH") { for (const c of n.childNodes) walk(c); out += " | "; return; }
      const block = BLOCK.test(t);
      if (block) out += "\n";
      if (t === "LI") out += "• ";
      for (const c of n.childNodes) walk(c);
      if (block) out += "\n";
    })(root);
    const lines = out.split("\n").map((s) => s.replace(/[ \t ]+/g, " ").replace(/\s*\|\s*$/, "").trim());
    const res = [];
    for (const l of lines) if (l || (res.length && res[res.length - 1])) res.push(l);
    return res.join("\n").trim();
  }

  function threadId(url) {
    const m = /\/threads\/(?:[^/]*\.)?(\d+)/.exec(url);
    return m ? m[1] : null;
  }

  function extractThread() {
    const h1 = document.querySelector("h1.p-title-value");
    let title = document.title;
    if (h1) {
      const c = h1.cloneNode(true);
      c.querySelectorAll(".label, .labelLink, .label-append").forEach((e) => e.remove());
      title = c.textContent.trim();
    }
    title = cleanTitle(title);
    // Кодексы часто идут несколькими постами автора подряд — берём их все
    const posts = [...document.querySelectorAll("article.message--post, article.message")];
    const author = posts[0]?.dataset.author;
    const parts = [];
    for (const p of posts) {
      if (author && p.dataset.author !== author) break;
      const body = p.querySelector(".message-body .bbWrapper") || p.querySelector(".bbWrapper");
      if (body) parts.push(toText(body));
    }
    const crumbs = [...document.querySelectorAll(".p-breadcrumbs li")]
      .map((li) => li.textContent.trim())
      .filter(Boolean);
    return {
      id: threadId(location.href) || location.pathname,
      title,
      url: location.origin + location.pathname,
      section: crumbs[crumbs.length - 1] || "Форум",
      text: parts.join("\n\n"),
    };
  }

  function collectSection(scan) {
    const items = [];
    const seen = new Set();
    const add = (href, kind) => {
      if (!href) return;
      const u = new URL(href, location.href);
      u.hash = "";
      if (kind === "thread") {
        u.search = "";
        u.pathname = u.pathname.replace(/\/(page-\d+|unread|latest|post-\d+)\/?$/, "/");
      }
      const key = kind + u.href;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ url: u.href, kind });
    };
    document.querySelectorAll(".structItem--thread .structItem-title a[href*='/threads/']").forEach((a) => {
      const t = a.textContent || "";
      if (!scan || (DOC_RE.test(t) && !SKIP_RE.test(t))) add(a.href, "thread");
    });
    document.querySelectorAll(".node-title a[href*='/forums/'], .node-subNodeFlatList a[href*='/forums/']").forEach((a) => {
      const t = a.textContent || "";
      if (scan && SKIP_RE.test(t)) return;
      add(a.href, scan && !LAW_RE.test(t) ? "scan" : "section");
    });
    const next = document.querySelector("a.pageNav-jump--next");
    if (next && !scan) add(next.href, "section");
    return items;
  }

  // ---------- панель ----------
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#14171c;color:#e8eaf0;" +
    "border:1px solid #f2475e;border-radius:12px;padding:12px 14px;font:13px/1.4 'Segoe UI',sans-serif;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:320px";
  const btnCss =
    "display:block;width:100%;margin-top:8px;padding:8px 10px;border-radius:8px;border:0;cursor:pointer;" +
    "font:600 13px 'Segoe UI',sans-serif;";

  function render(html, buttons) {
    box.innerHTML = `<div style="font-weight:700;color:#f2475e;margin-bottom:4px">Trace Helper</div><div>${html}</div>`;
    for (const [label, fn, primary] of buttons || []) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = btnCss + (primary ? "background:#f2475e;color:#1a1203" : "background:#252a33;color:#e8eaf0");
      b.onclick = fn;
      box.appendChild(b);
    }
    if (!box.isConnected) document.body.appendChild(box);
  }

  async function go(next) {
    if (next) setTimeout(() => (location.href = next), DELAY);
    else setTimeout(main, 300); // очередь кончилась — показать «Сбор закончен»
  }

  async function main() {
    if (!document.body) return;
    if (isChallenge()) return; // ждём, пока TraceGuard пропустит, страница перезагрузится сама

    const st = await invoke("forum_hello", { url: location.href });

    if (st.crawling) {
      render(`Собираю… осталось ${st.left}<br>Сохранено: ${st.saved}`, [
        ["Остановить", async () => { await invoke("forum_stop"); location.reload(); }],
      ]);
      try {
        if (isThread()) {
          const doc = extractThread();
          if (doc.text) return go(await invoke("forum_save", { doc }));
          return go(await invoke("forum_skip", { url: location.href }));
        }
        if (isSection()) return go(await invoke("forum_queue", { items: collectSection(st.kind === "scan"), start: false }));
        return go(await invoke("forum_skip", { url: location.href }));
      } catch (e) {
        return go(await invoke("forum_skip", { url: location.href }));
      }
    }

    const buttons = [];
    // Все разделы форума про законы и правила — одной кнопкой с любой страницы со списком разделов
    // законы и правила — целиком, остальные разделы — только темы с законами в названии
    const nodes = [...document.querySelectorAll(".node-title a[href*='/forums/'], .node-subNodeFlatList a[href*='/forums/']")]
      .filter((a) => !SKIP_RE.test(a.textContent || ""))
      .map((a) => ({ url: new URL(a.href, location.href).href, kind: LAW_RE.test(a.textContent || "") ? "section" : "scan" }));
    const uniq = [...new Map(nodes.map((x) => [x.url, x])).values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "section" ? -1 : 1));
    if (uniq.length) {
      buttons.push([
        `Собрать все законы и правила (весь форум, ${uniq.length} разд.)`,
        async () => go(await invoke("forum_queue", { items: uniq, start: true })),
        true,
      ]);
    }
    if (isSection()) {
      const n = document.querySelectorAll(".structItem--thread").length;
      buttons.push([
        `Добавить весь раздел (${n} тем + подразделы)`,
        async () => go(await invoke("forum_queue", { items: [{ url: location.href, kind: "section" }], start: true })),
        true,
      ]);
    }
    if (isThread()) {
      buttons.push([
        st.hasThis ? "Обновить эту тему" : "Добавить эту тему",
        async () => {
          await invoke("forum_save", { doc: extractThread() });
          main();
        },
        true,
      ]);
    }
    buttons.push(["Готово, закрыть форум", () => invoke("forum_close")]);
    const hint = isSection() || isThread()
      ? ""
      : uniq.length
        ? "Нажми кнопку ниже — программа сама обойдёт все разделы.<br>"
        : "Открой главную страницу форума или раздел с законами.<br>";
    render(`${hint}${st.done ? "<b>Сбор закончен.</b><br>" : ""}В приложении документов: ${st.saved}`, buttons);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
