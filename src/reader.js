// Lector reader: splits the visible text of a page into sentences, reads them aloud one at a time with
// the Web Speech API, highlights the current sentence, and lets you pause to ask a question about it.
// Injected into normal pages by background.js; loaded directly by viewer.html for PDFs.
(() => {
  if (window.__lector) return;
  const L = (window.__lector = {});

  const SKIP = "script,style,noscript,template,svg,math,nav,footer,aside,button,select,textarea,input,[aria-hidden=true],[hidden],#lector-host";
  const MAX_CHUNK = 260; // long run-on "sentences" (slides, lists) are cut so speech and highlight stay in step
  const state = {
    root: null, pdf: false, sentences: [], idx: 0, playing: false, open: false,
    token: 0, history: [], settings: { rate: 1.1, voiceURI: "", speakAnswers: true }, voice: null,
  };

  // ---------- text -> sentences ----------
  const displayCache = new WeakMap();
  function blockOf(node) {
    if (state.pdf) return node.parentElement.closest(".textLayer");
    let el = node.parentElement;
    while (el && el !== document.body) {
      let d = displayCache.get(el);
      if (d === undefined) displayCache.set(el, (d = getComputedStyle(el).display));
      if (!d.startsWith("inline") && d !== "contents") return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function pickRoot() {
    if (state.root) return state.root;
    const cands = [...document.querySelectorAll("article, main, [role=main]")];
    const best = cands.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    return best && best.innerText.length > 600 ? best : document.body;
  }

  function collect() {
    const root = pickRoot();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.data.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (!state.pdf && !p.checkVisibility({ visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let block = null, group = [];
    for (let n; (n = walker.nextNode()); ) {
      const b = blockOf(n);
      if (b !== block && group.length) { splitBlock(group, out); group = []; }
      block = b;
      group.push(n);
    }
    if (group.length) splitBlock(group, out);
    return out;
  }

  // In a PDF text layer each line is its own span. A new line that starts like a new item (capital,
  // bullet, digit) after a line with no closing punctuation is treated as a break, so slide bullets are
  // read as separate phrases instead of one run-on.
  function separator(prev, next) {
    if (!state.pdf) return " ";
    const a = prev.parentElement.getBoundingClientRect(), b = next.parentElement.getBoundingClientRect();
    const newLine = Math.abs(b.top - a.top) > Math.max(a.height, 4) * 0.6;
    if (!newLine) return " ";
    if (/-$/.test(prev.data)) return "";
    return !/[.!?:;,]\s*$/.test(prev.data) && /^\s*[\p{Lu}\d•●▪◦\-–]/u.test(next.data) ? "\n" : " ";
  }

  const segmenter = new Intl.Segmenter(document.documentElement.lang || "en", { granularity: "sentence" });
  function splitBlock(nodes, out) {
    let str = "";
    const map = [];
    nodes.forEach((n, i) => {
      if (i && !/\s$/.test(str) && !/^\s/.test(n.data)) str += separator(nodes[i - 1], n);
      map.push({ node: n, start: str.length, end: str.length + n.data.length });
      str += n.data;
    });
    const point = (p, isEnd) => {
      for (let k = 0; k < map.length; k++) {
        const m = map[k];
        if (p >= m.start && p <= m.end && !(isEnd && p === m.start && k > 0)) return [m.node, p - m.start];
        if (p < m.start) return isEnd ? [map[k - 1].node, map[k - 1].node.length] : [m.node, 0];
      }
      const last = map[map.length - 1];
      return [last.node, last.node.length];
    };
    for (const seg of segmenter.segment(str)) {
      for (const [a0, b0] of pieces(str, seg.index, seg.index + seg.segment.length)) {
        let a = a0, b = b0;
        while (a < b && /\s/.test(str[a])) a++;
        while (b > a && /\s/.test(str[b - 1])) b--;
        const text = str.slice(a, b);
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        const range = document.createRange();
        try {
          range.setStart(...point(a, false));
          range.setEnd(...point(b, true));
        } catch { continue; }
        out.push({ text: text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim(), range });
      }
    }
  }

  function pieces(str, a, b) {
    const res = [];
    let start = a;
    for (let i = a; i < b; i++) if (str[i] === "\n") { res.push([start, i]); start = i + 1; }
    res.push([start, b]);
    return res.flatMap(([s, e]) => cutLong(str, s, e));
  }
  function cutLong(str, a, b) {
    if (b - a <= MAX_CHUNK) return [[a, b]];
    const win = str.slice(a, a + MAX_CHUNK);
    let cut = Math.max(win.lastIndexOf("; "), win.lastIndexOf(": "), win.lastIndexOf(", "));
    if (cut < 100) cut = win.lastIndexOf(" ");
    if (cut < 60) cut = MAX_CHUNK - 1;
    return [[a, a + cut + 1], ...cutLong(str, a + cut + 1, b)];
  }

  // ---------- speech ----------
  async function loadSettings() {
    try {
      const s = await chrome.runtime.sendMessage({ type: "settings" });
      if (s) Object.assign(state.settings, s);
    } catch {}
    let voices = speechSynthesis.getVoices();
    if (!voices.length) {
      await new Promise((r) => { speechSynthesis.addEventListener("voiceschanged", r, { once: true }); setTimeout(r, 1500); });
      voices = speechSynthesis.getVoices();
    }
    state.voice =
      voices.find((v) => v.voiceURI === state.settings.voiceURI) ||
      voices.find((v) => /Google US English|Natural/.test(v.name) && v.lang.startsWith("en")) ||
      voices.find((v) => v.lang.startsWith("en")) || null;
  }

  function utter(text, onend) {
    const u = new SpeechSynthesisUtterance(text);
    if (state.voice) u.voice = state.voice;
    u.rate = state.settings.rate;
    const token = ++state.token;
    u.onend = () => token === state.token && onend && onend();
    u.onerror = (e) => token === state.token && !/interrupted|canceled/.test(e.error) && onend && onend();
    speechSynthesis.cancel();
    setTimeout(() => token === state.token && speechSynthesis.speak(u), 40); // Chrome drops a speak() issued right after cancel()
  }

  function readAt(i) {
    if (i >= state.sentences.length) { stop(); setStatus("Finished"); return; }
    state.idx = Math.max(0, i);
    const s = state.sentences[state.idx];
    highlight(s.range);
    setStatus(`${state.idx + 1} / ${state.sentences.length}`);
    utter(s.text, () => state.playing && readAt(state.idx + 1));
  }
  function play() { state.playing = true; ui.play.innerHTML = ICON.pause; readAt(state.idx); }
  function stop() { state.playing = false; state.token++; speechSynthesis.cancel(); if (ui.play) ui.play.innerHTML = ICON.play; }
  function step(d) { const was = state.playing; stop(); state.idx = Math.min(Math.max(state.idx + d, 0), state.sentences.length - 1); was ? play() : (highlight(state.sentences[state.idx].range), setStatus(`${state.idx + 1} / ${state.sentences.length}`)); }

  function highlight(range) {
    if (!window.CSS?.highlights) return;
    CSS.highlights.set("lector-current", new Highlight(range));
    const r = range.getBoundingClientRect();
    if (r.height && (r.top < 70 || r.bottom > innerHeight - 170)) scrollBy({ top: r.top - innerHeight * 0.33, behavior: "smooth" });
  }

  function firstVisible() {
    const i = state.sentences.findIndex((s) => s.range.getBoundingClientRect().bottom > 60);
    return i < 0 ? 0 : i;
  }
  function indexOfSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return -1;
    const r = sel.getRangeAt(0);
    return state.sentences.findIndex((s) => s.range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 && s.range.compareBoundaryPoints(Range.START_TO_END, r) > 0);
  }

  // ---------- asking ----------
  function context() {
    const i = state.idx, S = state.sentences;
    return {
      title: document.title, url: location.href,
      before: S.slice(Math.max(0, i - 30), i).map((s) => s.text),
      current: S[i]?.text || "",
      after: S.slice(i + 1, i + 6).map((s) => s.text),
    };
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  function listen(onText, hint) {
    if (!SR) { ui.input.focus(); return; }
    try { rec?.abort(); } catch {}
    rec = new SR();
    rec.lang = state.voice?.lang || "en-US";
    rec.interimResults = true;
    let finalText = "";
    ui.mic.classList.add("on");
    setAskStatus(hint || "Listening…");
    rec.onresult = (e) => {
      const t = [...e.results].map((r) => r[0].transcript).join("");
      ui.input.value = t;
      if (e.results[e.results.length - 1].isFinal) finalText = t;
    };
    rec.onerror = (e) => setAskStatus(e.error === "not-allowed" ? "Microphone blocked. Allow it for this site, or type instead." : e.error === "no-speech" ? "Didn't catch that. Type, or press the mic again." : "Mic error: " + e.error);
    rec.onend = () => { ui.mic.classList.remove("on"); if (finalText.trim()) onText(finalText.trim()); };
    rec.start();
  }

  function openAsk() {
    if (!state.open) return;
    stop();
    state.history = [];
    ui.panel.hidden = false;
    ui.answer.textContent = "";
    ui.input.value = "";
    ui.cur.textContent = "“" + (state.sentences[state.idx]?.text || "") + "”";
    setAskStatus("Ask about what you just heard.");
    listen(submit, "Listening… ask your question");
  }

  async function submit(q) {
    q = (q ?? ui.input.value).trim();
    if (!q) return;
    if (/^(continue|go on|resume|carry on|keep going|ok(ay)?|got it|thanks?( you)?|next)\.?$/i.test(q)) return resume();
    ui.input.value = "";
    setAskStatus("Thinking…");
    ui.answer.innerHTML = "";
    const qEl = el("p", "q", q);
    ui.answer.append(qEl);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "ask", question: q, context: context(), history: state.history });
    } catch (e) { res = { error: e.message }; }
    if (res?.error) { setAskStatus(""); ui.answer.append(el("p", "err", res.error)); return; }
    const answer = res.answer.replace(/[*_#`]+/g, "");
    state.history.push({ q, a: answer });
    ui.answer.append(el("p", "a", answer));
    setAskStatus("Say “continue” or ask a follow-up.");
    const after = () => listen(submit, "Listening… say “continue” or ask more");
    state.settings.speakAnswers ? utter(answer, after) : after();
  }

  function resume() {
    try { rec?.abort(); } catch {}
    ui.panel.hidden = true;
    play();
  }

  // ---------- UI ----------
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12 18 18V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    ask: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zm.9 14h-1.8v-1.8h1.8zm1.9-6.3-.8.8c-.6.6-1 1.1-1 2.5h-1.8V13c0-1 .4-1.9 1-2.5l1.1-1.1a1.8 1.8 0 1 0-3.1-1.3H8.4a3.6 3.6 0 1 1 6.4 3.6z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
  };
  const CSS_TEXT = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:4px;
      padding:6px 8px;border-radius:999px;background:#1d1b17;color:#f3efe8;box-shadow:0 8px 30px rgb(0 0 0/.35);font-size:13px}
    button{all:unset;cursor:pointer;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;color:inherit}
    button:hover{background:#2f2c26} button:focus-visible{outline:2px solid #d97757}
    button.main{background:#d97757;color:#fff;width:40px;height:40px} button.main:hover{background:#c4663f}
    svg{width:20px;height:20px;fill:currentColor}
    .rate{min-width:44px;text-align:center;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none}
    .status{min-width:64px;text-align:center;color:#a39d93;font-variant-numeric:tabular-nums;padding:0 4px}
    .sep{width:1px;height:20px;background:#3a362f;margin:0 2px}
    .panel{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;width:min(560px,calc(100vw - 32px));
      max-height:60vh;overflow:auto;padding:14px 16px;border-radius:16px;background:#faf7f2;color:#1f1d1a;box-shadow:0 12px 40px rgb(0 0 0/.3);font-size:15px;line-height:1.5}
    .cur{font-size:13px;color:#6b665e;margin:0 0 10px;font-style:italic;max-height:4.5em;overflow:hidden}
    .row{display:flex;gap:6px;align-items:center}
    input{all:unset;flex:1;padding:9px 12px;border-radius:10px;background:#fff;border:1px solid #e4ddd2;font-size:15px;color:#1f1d1a}
    input:focus{border-color:#d97757}
    .panel button{color:#1f1d1a} .panel button:hover{background:#efe9df}
    .mic.on{background:#d97757;color:#fff;animation:p 1.2s infinite}
    @keyframes p{50%{box-shadow:0 0 0 6px rgb(217 119 87/.25)}}
    .ask-status{font-size:12px;color:#6b665e;margin:8px 0 0}
    .q{font-weight:600;margin:12px 0 4px} .a{margin:0} .err{color:#b3261e;margin:8px 0 0}
    .actions{display:flex;gap:8px;margin-top:12px}
    .panel .pill{all:unset;cursor:pointer;padding:7px 14px;border-radius:999px;background:#1d1b17;color:#f3efe8;font-size:13px;width:auto;height:auto}
    .panel .pill:hover{background:#2f2c26}
    .panel .pill.ghost{background:transparent;color:#1f1d1a;border:1px solid #e4ddd2}
    @media (prefers-color-scheme: dark){
      .panel{background:#1d1b17;color:#f3efe8} input{background:#14130f;border-color:#3a362f;color:#f3efe8}
      .panel button{color:#f3efe8} .panel button:hover{background:#2f2c26} .cur,.ask-status{color:#a39d93}
      .panel .pill{background:#f3efe8;color:#1d1b17} .panel .pill.ghost{background:transparent;color:#f3efe8;border-color:#3a362f}
    }`;
  const ui = {};
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (icon, title, fn, cls = "") => { const b = el("button", cls); b.innerHTML = ICON[icon]; b.title = title; b.setAttribute("aria-label", title); b.onclick = fn; return b; };
  const setStatus = (t) => ui.status && (ui.status.textContent = t);
  const setAskStatus = (t) => ui.askStatus && (ui.askStatus.textContent = t);

  function buildUI() {
    const host = el("div");
    host.id = "lector-host";
    const root = host.attachShadow({ mode: "open" });
    const style = el("style", null, CSS_TEXT);
    ui.prev = btn("prev", "Previous sentence (←)", () => step(-1));
    ui.play = btn("play", "Play / pause (Space)", () => (state.playing ? stop() : play()), "main");
    ui.next = btn("next", "Next sentence (→)", () => step(1));
    ui.rate = el("span", "rate", state.settings.rate.toFixed(1) + "×");
    ui.rate.title = "Speed: click to change";
    ui.rate.onclick = () => {
      const steps = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
      state.settings.rate = steps[(steps.indexOf(state.settings.rate) + 1) % steps.length] || 1;
      ui.rate.textContent = state.settings.rate.toFixed(2).replace(/0$/, "") + "×";
      if (state.playing) readAt(state.idx);
    };
    ui.status = el("span", "status", "");
    const bar = el("div", "bar");
    bar.append(ui.prev, ui.play, ui.next, el("span", "sep"), ui.rate, ui.status, el("span", "sep"),
      btn("ask", "Pause and ask (A)", openAsk), btn("gear", "Settings", () => chrome.runtime.sendMessage({ type: "options" })), btn("close", "Close (Esc)", close));

    ui.panel = el("div", "panel");
    ui.panel.hidden = true;
    ui.cur = el("p", "cur");
    ui.input = el("input");
    ui.input.placeholder = "Why is it like this?";
    ui.input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") submit(); if (e.key === "Escape") resume(); };
    ui.mic = btn("mic", "Speak your question", () => listen(submit), "mic");
    const row = el("div", "row");
    row.append(ui.input, ui.mic);
    ui.askStatus = el("p", "ask-status");
    ui.answer = el("div");
    const cont = el("button", "pill", "Continue reading");
    cont.onclick = resume;
    const more = el("button", "pill ghost", "Ask more");
    more.onclick = () => listen(submit, "Listening… ask more");
    const actions = el("div", "actions");
    actions.append(cont, more);
    ui.panel.append(ui.cur, row, ui.askStatus, ui.answer, actions);
    root.append(style, bar, ui.panel);
    document.documentElement.append(host);
    ui.host = host;

    const hl = el("style");
    hl.id = "lector-style";
    hl.textContent = "::highlight(lector-current){background-color:rgb(255 214 102/.75);color:inherit}";
    document.head.append(hl);
    ui.hl = hl;
  }

  function onKey(e) {
    if (!state.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.composedPath()[0];
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName)) return;
    const k = e.key;
    if (k === " ") state.playing ? stop() : ui.panel.hidden ? play() : resume();
    else if (k === "ArrowLeft") step(-1);
    else if (k === "ArrowRight") step(1);
    else if (k === "a" || k === "A") openAsk();
    else if (k === "Escape") ui.panel.hidden ? close() : resume();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  async function open(startAt) {
    if (!state.open) {
      await loadSettings();
      state.sentences = collect();
      if (!state.sentences.length) { alert("Lector found no readable text on this page."); return; }
      buildUI();
      addEventListener("keydown", onKey, true);
      state.open = true;
    }
    state.idx = startAt ?? firstVisible();
    play();
  }
  function close() {
    stop();
    try { rec?.abort(); } catch {}
    CSS.highlights?.delete("lector-current");
    ui.host?.remove();
    ui.hl?.remove();
    removeEventListener("keydown", onKey, true);
    state.open = false;
  }

  // Called by viewer.js: read only the PDF text layers.
  L.setRoot = (root, opts = {}) => { state.root = root; state.pdf = !!opts.pdf; };
  L.command = async (cmd) => {
    if (cmd === "toggle") return state.open ? close() : open();
    if (cmd === "ask") { if (!state.open) await open(); return openAsk(); }
    if (cmd === "fromSelection") {
      if (!state.open) { await loadSettings(); state.sentences = collect(); }
      const i = indexOfSelection();
      return open(i >= 0 ? i : undefined);
    }
  };
  L._state = state; // for tests
  L._collect = collect;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "lector" && (msg.tabId == null || msg.tabId === L.tabId)) L.command(msg.cmd);
  });
})();
