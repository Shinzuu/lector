// Lector reader: splits the visible text of a page into sections (PDF pages, or the parts under each
// heading) and sentences, reads them aloud, highlights where it is, and lets you pause to ask about it.
// Narrated mode replaces each section with a spoken, tutor-style script written by the LLM.
// Injected into normal pages by background.js; loaded directly by viewer.html for PDFs.
(() => {
  if (window.__lector) return;
  const L = (window.__lector = {});

  const SKIP = "script,style,noscript,template,svg,math,nav,footer,aside,button,select,textarea,input,[aria-hidden=true],[hidden],#lector-host,[data-lector-skip]";
  const MAX_CHUNK = 260; // long run-on "sentences" (slides, lists) are cut so speech and highlight stay in step
  const state = {
    root: null, pdf: false, sections: [], sec: null, items: null, i: 0, mode: "original", heard: [],
    playing: false, open: false, token: Date.now(), loop: 0, history: [], // tokens increase across tabs and pages
    settings: { rate: 1, voiceURI: "", speakAnswers: true }, voice: null,
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

  // ---------- sections ----------
  // A section is one PDF page, or the stretch of a web page under one h1–h3 heading. Sections are what
  // you skip, jump between, and what Narrated mode rewrites.
  const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const PAGE_NUMBER = /^(page )?#( ?(\/|of) ?#)?$/;

  // Slide headers and footers repeat on most pages ("Dept. of CSE … 3 / 34"). Drop any line that shows up
  // on at least 40% of pages, and bare page numbers.
  function dropBoilerplate(sections) {
    const pagesWith = new Map();
    for (const sec of sections) for (const k of new Set(sec.items.map((x) => norm(x.text)))) pagesWith.set(k, (pagesWith.get(k) || 0) + 1);
    const limit = Math.max(3, sections.length * 0.4);
    for (const sec of sections) {
      sec.items = sec.items.filter((x) => {
        const k = norm(x.text);
        return !PAGE_NUMBER.test(k) && !(sections.length >= 4 && pagesWith.get(k) >= limit);
      });
    }
  }

  // Footer and header strips sit in the top or bottom edge of every slide. Mark spans there whose text
  // repeats on many pages, so they never even become sentences (they can share a line with real text).
  function markPdfEdges() {
    const pages = [...state.root.querySelectorAll(".page")];
    if (pages.length < 4) return;
    const seen = new Map(), edge = [];
    for (const p of pages) {
      const box = p.getBoundingClientRect();
      for (const sp of p.querySelectorAll(".textLayer span:not(.markedContent)")) {
        const r = sp.getBoundingClientRect();
        const y = (r.top + r.height / 2 - box.top) / box.height;
        if (y > 0.07 && y < 0.93) continue;
        const k = norm(sp.textContent);
        if (!k) continue;
        edge.push([sp, k]);
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k).add(p);
      }
    }
    const limit = Math.max(3, pages.length * 0.4);
    for (const [sp, k] of edge) if (seen.get(k).size >= limit || PAGE_NUMBER.test(k)) sp.setAttribute("data-lector-skip", "");
  }

  function buildSections() {
    if (state.pdf) markPdfEdges();
    const all = collect();
    let sections = [];
    if (state.pdf) {
      const pages = [...state.root.querySelectorAll(".page")];
      const byPage = new Map(pages.map((p, i) => [p, { el: p, items: [], label: "Page " + (i + 1) }]));
      for (const s of all) byPage.get(s.range.startContainer.parentElement?.closest(".page"))?.items.push(s);
      sections = [...byPage.values()];
      dropBoilerplate(sections);
      for (const sec of sections) sec.title = sec.items[0]?.text.slice(0, 80) || "";
    } else {
      const heads = [...pickRoot().querySelectorAll("h1,h2,h3")].filter((h) => h.textContent.trim() && h.checkVisibility());
      let cur = { el: null, title: document.title || "Start", items: [] };
      sections.push(cur);
      let h = 0;
      for (const s of all) {
        while (h < heads.length && heads[h].compareDocumentPosition(s.range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) {
          cur = { el: heads[h], title: heads[h].textContent.trim().replace(/\s+/g, " ").slice(0, 80), items: [] };
          sections.push(cur);
          h++;
        }
        cur.items.push(s);
      }
    }
    if (!state.pdf) sections.filter((s) => s.items.length).forEach((sec, i) => (sec.label = "Section " + (i + 1)));
    // Long stretches (a whole week of notes under one heading) are cut into parts of about 25 sentences,
    // so each part is narrated quickly and can be skipped on its own.
    const PART = 25;
    sections = sections.filter((s) => s.items.length).flatMap((s) => {
      if (s.items.length <= PART * 1.4) return [s];
      const n = Math.ceil(s.items.length / PART), out = [];
      for (let k = 0; k < n; k++) {
        const items = s.items.slice(k * PART, (k + 1) * PART);
        out.push({ ...s, items, el: k ? null : s.el, label: `${s.label}.${k + 1}`, title: k ? items[0].text.slice(0, 80) : s.title });
      }
      return out;
    });
    return sections.map((s, id) => Object.assign(s, { id, skip: false, narration: null }));
  }

  // ---------- pronunciation ----------
  // Applied to every line before it is spoken. Users add their own in Options ("WORD = how to say it").
  const DEFAULT_LEXICON = `YARN = Yarn
HDFS = H D F S
e.g. = for example
i.e. = that is
etc. = et cetera
vs. = versus
vs = versus
w.r.t. = with respect to
approx. = approximately
& = and
→ = leads to
⇒ = implies
≈ = approximately
≤ = less than or equal to
≥ = greater than or equal to
× = times
PySpark = Pie Spark
SerDe = Sir Dee
JSON = Jason
Avro = Av-ro
Parquet = Par-kay
ORC = O R C
OLAP = Oh-lap
OLTP = O L T P
ACID = acid
CAP = cap
NoSQL = No S Q L`;
  let lexicon = [];
  function compileLexicon(extra = "") {
    const map = new Map();
    for (const line of (DEFAULT_LEXICON + "\n" + extra).split("\n")) {
      const m = line.match(/^\s*(.+?)\s*=\s*(.*?)\s*$/);
      if (m && m[1]) map.set(m[1], m[2]);
    }
    lexicon = [...map].sort((a, b) => b[0].length - a[0].length).map(([k, v]) => {
      const e = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const word = /^[\w]/.test(k) && /[\w.]$/.test(k);
      return [new RegExp(word ? `(?<![\\w-])${e}(?![\\w-])` : e, "g"), v];
    });
  }
  const UNITS = { KB: "kilobytes", MB: "megabytes", GB: "gigabytes", TB: "terabytes", PB: "petabytes", ms: "milliseconds", Gbps: "gigabits per second", Mbps: "megabits per second" };
  function speakable(text) {
    let t = text.replace(/(\d)\s?(KB|MB|GB|TB|PB|ms|Gbps|Mbps)\b/g, (_, d, u) => `${d} ${UNITS[u]}`);
    t = t.replace(/[•●▪◦]\s*/g, "").replace(/\s[–—-]\s/g, ", ");
    for (const [re, v] of lexicon) t = t.replace(re, v);
    return t;
  }

  // ---------- speech ----------
  async function loadSettings() {
    try {
      const s = await chrome.runtime.sendMessage({ type: "settings" });
      if (s) Object.assign(state.settings, s);
    } catch {}
    compileLexicon(state.settings.lexicon || "");
    state.mode = state.settings.mode === "narrated" && state.settings.hasKey ? "narrated" : "original";
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

  // Neural voice through the background (Edge), falling back to Chrome's own voices if it fails.
  function utter(text, onend, next = []) {
    const token = ++state.token;
    state.onend = onend;
    speechSynthesis.cancel();
    text = speakable(text);
    next = next.map(speakable);
    if (state.settings.engine === "edge" && !state.edgeDown) {
      chrome.runtime.sendMessage({ type: "tts", text, next, token, rate: state.settings.rate, tabId: L.tabId }).then((r) => {
        if (token !== state.token) return;
        if (r?.error) { state.edgeDown = true; state.edgeError = r.error; note("Neural voice unavailable, using Chrome's voice"); browserUtter(text, token); }
      }, (e) => { state.edgeError = e?.message; if (token === state.token) { state.edgeDown = true; browserUtter(text, token); } });
      return;
    }
    browserUtter(text, token);
  }
  function browserUtter(text, token) {
    const u = new SpeechSynthesisUtterance(text);
    if (state.voice) u.voice = state.voice;
    u.rate = state.settings.rate;
    u.onend = () => ended(token);
    u.onerror = (e) => !/interrupted|canceled/.test(e.error) && ended(token);
    setTimeout(() => token === state.token && speechSynthesis.speak(u), 40); // Chrome drops a speak() issued right after cancel()
  }
  function ended(token) { if (token === state.token && state.onend) state.onend(); }
  function silence() { state.token++; speechSynthesis.cancel(); chrome.runtime.sendMessage({ type: "tts-stop", token: state.token }).catch(() => {}); }

  // ---------- narration ----------
  const splitSpoken = (text) => [...segmenter.segment(text || "")].map((s) => s.segment.trim()).filter((t) => /[\p{L}\p{N}]/u.test(t)).map((text) => ({ text, range: null }));
  const original = (sec) => sec.items.map((x) => ({ text: x.text, range: x.range }));

  // Ask the background for spoken scripts of this section and the next few not yet requested (one call per batch).
  function requestNarration(k) {
    const batch = [];
    for (let j = k; j < state.sections.length && batch.length < 4; j++) {
      const s = state.sections[j];
      if (!s.skip && !s.narration) batch.push(s);
    }
    if (!batch.length) return;
    const p = chrome.runtime.sendMessage({
      type: "narrate", title: document.title, url: location.href,
      sections: batch.map((s) => ({ id: s.id, text: s.items.map((x) => x.text).join("\n") })),
    }).then((r) => { if (!r || r.error) throw new Error(r?.error || "no reply"); return r.sections; });
    for (const s of batch) s.narration = p.then((list) => splitSpoken(list.find((x) => x.id === s.id)?.narration));
  }

  async function itemsFor(k) {
    const sec = state.sections[k];
    if (state.mode !== "narrated") return original(sec);
    if (!sec.narration) requestNarration(k);
    try {
      return await sec.narration;
    } catch (e) {
      sec.narration = null;
      note("Narration failed (" + e.message.slice(0, 80) + "). Reading the original text.");
      return original(sec);
    }
  }

  // ---------- playback ----------
  // ---------- progress ----------
  // Time is estimated from the source word count: the neural voice speaks about 155 words a minute at 1x,
  // and narration runs about as long as the source.
  const WPM = 155;
  const words = (sec) => (sec.words ??= sec.items.reduce((n, x) => n + x.text.split(/\s+/).length, 0));
  const fmtTime = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m` : `${Math.max(1, Math.round(min))}m`);
  function progress() {
    let total = 0, done = 0;
    state.sections.forEach((sec, k) => {
      if (sec.skip) return;
      const w = words(sec);
      total += w;
      if (k < state.sec) done += w;
      else if (k === state.sec && state.items?.length) done += w * (state.i / state.items.length);
    });
    const rate = WPM * state.settings.rate;
    return { pct: total ? Math.round((100 * done) / total) : 0, left: (total - done) / rate, total: total / rate };
  }

  const included = (k, dir) => { for (; k >= 0 && k < state.sections.length; k += dir) if (!state.sections[k].skip) return k; return -1; };

  async function playSection(k, i = 0) {
    const loop = ++state.loop;
    k = included(k, 1);
    if (k < 0) { stop(); setStatus("Finished"); return; }
    state.sec = k;
    const sec = state.sections[k];
    setStatus(`${sec.label} · loading`);
    if (sec.el) sec.el.scrollIntoView({ behavior: "smooth", block: "start" });
    else { const r = sec.items[0]?.range.getBoundingClientRect(); if (r) scrollBy({ top: r.top - 120, behavior: "smooth" }); }
    const items = await itemsFor(k);
    if (loop !== state.loop || !state.playing) return;
    if (state.mode === "narrated") { const n = included(k + 1, 1); if (n >= 0 && !state.sections[n].narration) requestNarration(n); }
    state.items = items;
    state.i = i < 0 ? Math.max(0, items.length + i) : Math.min(i, Math.max(0, items.length - 1));
    if (!items.length) return playSection(k + 1);
    renderSections();
    readItem();
  }

  function readItem() {
    const { items, i } = state, sec = state.sections[state.sec];
    if (i >= items.length) return playSection(state.sec + 1);
    const it = items[i];
    highlight(it.range || sec.items[0]?.range, !it.range);
    caption(state.mode === "narrated" ? it.text : "");
    const pr = progress();
    setStatus(`${sec.label} · ${pr.pct}% · ${fmtTime(pr.left)} left`);
    ui.status.title = `${i + 1} of ${items.length} lines in this section. Whole read: ${fmtTime(pr.total)} at ${state.settings.rate}×, skipped sections not counted.`;
    state.heard.push(it.text);
    if (state.heard.length > 80) state.heard.shift();
    const next = items.slice(i + 1, i + 3).map((x) => x.text);
    utter(it.text, () => { if (state.playing) { state.i++; readItem(); } }, next);
  }

  function play() { state.playing = true; ui.play.innerHTML = ICON.pause; state.items ? readItem() : playSection(state.sec ?? 0); }
  function stop() { state.playing = false; state.loop++; silence(); if (ui.play) ui.play.innerHTML = ICON.play; }
  function restartAt(k, i) { stop(); state.items = null; state.playing = true; ui.play.innerHTML = ICON.pause; playSection(k, i); }
  function step(d) {
    const i = state.i + d;
    if (i < 0) { const k = included(state.sec - 1, -1); return k >= 0 ? restartAt(k, -1) : restartAt(state.sec, 0); }
    if (i >= state.items.length) return restartAt(state.sec + 1, 0);
    stop(); state.i = i; play();
  }
  function stepSection(d) { const k = included(state.sec + d, d); if (k >= 0) restartAt(k, 0); }

  function highlight(range, sectionOnly) {
    if (!window.CSS?.highlights || !range) return;
    CSS.highlights.set("lector-current", new Highlight(range));
    if (sectionOnly) return; // in Narrated mode the section scrolls into view when it starts
    const r = range.getBoundingClientRect();
    if (r.height && (r.top < 70 || r.bottom > innerHeight - 170)) scrollBy({ top: r.top - innerHeight * 0.33, behavior: "smooth" });
  }

  function sectionAtViewport() {
    const k = state.sections.findIndex((s) => s.items.some((x) => x.range.getBoundingClientRect().bottom > 60));
    return k < 0 ? 0 : k;
  }
  function positionOfSelection() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    for (const sec of state.sections) {
      const i = sec.items.findIndex((s) => s.range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 && s.range.compareBoundaryPoints(Range.START_TO_END, r) > 0);
      if (i >= 0) return [sec.id, state.mode === "narrated" ? 0 : i];
    }
    return null;
  }

  // ---------- asking ----------
  function context() {
    const sec = state.sections[state.sec];
    return {
      title: document.title, url: location.href,
      before: state.heard.slice(-31, -1),
      current: state.items?.[state.i]?.text || "",
      after: (state.items || []).slice(state.i + 1, state.i + 6).map((s) => s.text),
      // The source around where you are: the previous section, this one and the next three.
      sectionText: sec ? state.sections.slice(Math.max(0, state.sec - 1), state.sec + 4)
        .map((s) => `[${s.label}: ${s.title}]\n` + s.items.map((x) => x.text).join("\n")).join("\n\n").slice(0, 8000) : "",
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
    ui.list.hidden = true;
    caption("");
    ui.answer.textContent = "";
    ui.input.value = "";
    ui.cur.textContent = "“" + (state.items?.[state.i]?.text || "") + "”";
    setAskStatus("Ask about what you just heard.");
    listen(submit, "Listening… ask your question");
  }

  async function submit(q) {
    q = (q ?? ui.input.value).trim();
    if (!q) return;
    if (/^(continue|go on|resume|carry on|keep going|ok(ay)?|got it|thanks?( you)?|next)\.?$/i.test(q)) return resume();
    ui.input.value = "";
    setAskStatus("Thinking…");
    ui.answer.replaceChildren(el("p", "q", q));
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
    secPrev: '<svg viewBox="0 0 24 24"><path d="M11 18V6l-8.5 6zm.5-6 8.5 6V6z"/></svg>',
    secNext: '<svg viewBox="0 0 24 24"><path d="M4 18l8.5-6L4 6zm9-12v12l8.5-6z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 5h2v2H4zm4 0h12v2H8z"/></svg>',
    ask: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3zm.9 14h-1.8v-1.8h1.8zm1.9-6.3-.8.8c-.6.6-1 1.1-1 2.5h-1.8V13c0-1 .4-1.9 1-2.5l1.1-1.1a1.8 1.8 0 1 0-3.1-1.3H8.4a3.6 3.6 0 1 1 6.4 3.6z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
  };
  const CSS_TEXT = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:2px;
      padding:6px 8px;border-radius:999px;background:#1d1b17;color:#f3efe8;box-shadow:0 8px 30px rgb(0 0 0/.35);font-size:13px;max-width:calc(100vw - 16px)}
    button{all:unset;cursor:pointer;width:34px;height:34px;display:grid;place-items:center;border-radius:50%;color:inherit;flex:none}
    button:hover{background:#2f2c26} button:focus-visible{outline:2px solid #d97757}
    button.main{background:#d97757;color:#fff;width:40px;height:40px} button.main:hover{background:#c4663f}
    svg{width:20px;height:20px;fill:currentColor}
    .chip{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;border:1px solid #3a362f;font-size:12px;white-space:nowrap;user-select:none}
    .chip:hover{background:#2f2c26} .chip.on{border-color:#d97757;color:#f0a385}
    .status{min-width:150px;text-align:center;color:#a39d93;font-variant-numeric:tabular-nums;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
    .sep{width:1px;height:20px;background:#3a362f;margin:0 3px;flex:none}
    .caption{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:2147483646;width:min(720px,calc(100vw - 32px));
      padding:10px 16px;border-radius:12px;background:rgb(29 27 23/.92);color:#f3efe8;font-size:17px;line-height:1.45;text-align:center;box-shadow:0 6px 24px rgb(0 0 0/.3)}
    .note{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:10px;background:#5c2b1e;color:#fff;font-size:13px;max-width:min(560px,calc(100vw - 32px))}
    .panel,.list{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;width:min(560px,calc(100vw - 32px));
      max-height:60vh;overflow:auto;padding:14px 16px;border-radius:16px;background:#faf7f2;color:#1f1d1a;box-shadow:0 12px 40px rgb(0 0 0/.3);font-size:15px;line-height:1.5}
    .list h3{margin:0 0 4px;font-size:15px} .list .hint{margin:0 0 10px;font-size:12px;color:#6b665e}
    .list .row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px}
    .list .row.now{background:#f3e3d6} .list .row.skip .t{opacity:.45;text-decoration:line-through}
    .list input{all:revert;accent-color:#d97757;width:16px;height:16px;flex:none}
    .list .t{all:unset;cursor:pointer;flex:1;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .list .t b{color:#6b665e;font-weight:500;margin-right:6px}
    .list .m{font-size:12px;color:#6b665e;font-variant-numeric:tabular-nums;flex:none}
    .list .tools{display:flex;gap:8px;margin-bottom:8px}
    .cur{font-size:13px;color:#6b665e;margin:0 0 10px;font-style:italic;max-height:4.5em;overflow:hidden}
    .ask-row{display:flex;gap:6px;align-items:center}
    .panel input{all:unset;flex:1;padding:9px 12px;border-radius:10px;background:#fff;border:1px solid #e4ddd2;font-size:15px;color:#1f1d1a}
    .panel input:focus{border-color:#d97757}
    .panel button,.list button.t{color:#1f1d1a} .panel button:hover{background:#efe9df}
    .mic.on{background:#d97757;color:#fff;animation:p 1.2s infinite}
    @keyframes p{50%{box-shadow:0 0 0 6px rgb(217 119 87/.25)}}
    .ask-status{font-size:12px;color:#6b665e;margin:8px 0 0}
    .q{font-weight:600;margin:12px 0 4px} .a{margin:0} .err{color:#b3261e;margin:8px 0 0}
    .actions{display:flex;gap:8px;margin-top:12px}
    .pill,.panel .pill,.list .pill{all:unset;cursor:pointer;padding:7px 14px;border-radius:999px;background:#1d1b17;color:#f3efe8;font-size:13px}
    .panel .pill:hover,.list .pill:hover{background:#2f2c26}
    .panel .pill.ghost,.list .pill.ghost{background:transparent;color:#1f1d1a;border:1px solid #e4ddd2}
    @media (prefers-color-scheme: dark){
      .panel,.list{background:#1d1b17;color:#f3efe8} .panel input{background:#14130f;border-color:#3a362f;color:#f3efe8}
      .panel button,.list button.t{color:#f3efe8} .panel button:hover{background:#2f2c26} .cur,.ask-status,.list .hint,.list .t b{color:#a39d93}
      .list .row.now{background:#3a2a22}
      .panel .pill,.list .pill{background:#f3efe8;color:#1d1b17} .panel .pill.ghost,.list .pill.ghost{background:transparent;color:#f3efe8;border-color:#3a362f}
    }`;
  const ui = {};
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // Only real clicks and keys count, so a web page cannot script Lector into spending your API key.
  const trusted = (fn) => (e) => { if (e?.isTrusted !== false) fn(e); };
  const btn = (icon, title, fn, cls = "") => { const b = el("button", cls); b.innerHTML = ICON[icon]; b.title = title; b.setAttribute("aria-label", title); b.onclick = trusted(fn); return b; };
  const setStatus = (t) => ui.status && (ui.status.textContent = t);
  const setAskStatus = (t) => ui.askStatus && (ui.askStatus.textContent = t);
  const caption = (t) => { if (!ui.caption) return; ui.caption.hidden = !t; ui.caption.textContent = t; };
  let noteTimer;
  const note = (t) => { if (!ui.note) return; ui.note.textContent = t; ui.note.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => (ui.note.hidden = true), 6000); };

  function renderSections() {
    if (!ui.rows) return;
    const pr = progress();
    ui.listHead.textContent = `Sections · ${pr.pct}% done · ${fmtTime(pr.left)} left of ${fmtTime(pr.total)}`;
    ui.rows.replaceChildren(...state.sections.map((sec) => {
      const row = el("div", "row" + (sec.id === state.sec ? " now" : "") + (sec.skip ? " skip" : ""));
      const box = el("input");
      box.type = "checkbox";
      box.checked = !sec.skip;
      box.title = "Include this section";
      box.onchange = trusted(() => { sec.skip = !box.checked; renderSections(); });
      const t = el("button", "t");
      t.append(el("b", null, sec.label), document.createTextNode(sec.title));
      const mins = el("span", "m", fmtTime(words(sec) / (WPM * state.settings.rate)));
      t.onclick = trusted(() => { sec.skip = false; ui.list.hidden = true; restartAt(sec.id, 0); });
      row.append(box, t, mins);
      return row;
    }));
  }

  function setMode(mode) {
    if (mode === "narrated" && !state.settings.hasKey) { note("Narrated mode needs a Gemini or Anthropic key in Settings."); mode = "original"; }
    state.mode = mode;
    ui.mode.textContent = mode === "narrated" ? "Narrated" : "Original";
    ui.mode.classList.toggle("on", mode === "narrated");
    caption("");
    if (state.open && state.sec != null) restartAt(state.sec, 0);
  }

  function buildUI() {
    const host = el("div");
    host.id = "lector-host";
    const root = host.attachShadow({ mode: "closed" });
    const style = el("style", null, CSS_TEXT);
    ui.play = btn("play", "Play / pause (Space)", () => (state.playing ? stop() : play()), "main");
    ui.mode = el("button", "chip");
    ui.mode.title = "Narrated: a tutor-style script of each section. Original: the text as written. (M)";
    ui.mode.onclick = trusted(() => setMode(state.mode === "narrated" ? "original" : "narrated"));
    ui.rate = el("button", "chip", state.settings.rate.toFixed(2).replace(/0$/, "") + "×");
    ui.rate.title = "Speed: click to change";
    ui.rate.onclick = trusted(() => {
      const steps = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
      state.settings.rate = steps[(steps.indexOf(state.settings.rate) + 1) % steps.length] || 1;
      ui.rate.textContent = state.settings.rate.toFixed(2).replace(/0$/, "") + "×";
      if (state.playing) { stop(); play(); }
    });
    ui.status = el("span", "status", "");
    const bar = el("div", "bar");
    bar.append(
      btn("secPrev", "Previous section (Shift+←)", () => stepSection(-1)),
      btn("prev", "Previous sentence (←)", () => step(-1)),
      ui.play,
      btn("next", "Next sentence (→)", () => step(1)),
      btn("secNext", "Next section (Shift+→)", () => stepSection(1)),
      el("span", "sep"), ui.mode, ui.rate, ui.status, el("span", "sep"),
      btn("list", "Sections: jump or skip (S)", toggleList),
      btn("ask", "Pause and ask (A)", openAsk),
      btn("gear", "Settings", () => chrome.runtime.sendMessage({ type: "options" })),
      btn("close", "Close (Esc)", close),
    );

    ui.caption = el("div", "caption");
    ui.caption.hidden = true;
    ui.note = el("div", "note");
    ui.note.hidden = true;

    ui.list = el("div", "list");
    ui.list.hidden = true;
    const tools = el("div", "tools");
    const all = el("button", "pill ghost", "Include all");
    all.onclick = trusted(() => { state.sections.forEach((s) => (s.skip = false)); renderSections(); });
    const none = el("button", "pill ghost", "Skip all");
    none.onclick = trusted(() => { state.sections.forEach((s) => (s.skip = true)); renderSections(); });
    tools.append(all, none);
    ui.rows = el("div");
    ui.listHead = el("h3", null, "Sections");
    ui.list.append(ui.listHead, el("p", "hint", "Untick to skip. Click a title to jump there."), tools, ui.rows);

    ui.panel = el("div", "panel");
    ui.panel.hidden = true;
    ui.cur = el("p", "cur");
    ui.input = el("input");
    ui.input.placeholder = "Why is it like this?";
    ui.input.onkeydown = (e) => { e.stopPropagation(); if (!e.isTrusted) return; if (e.key === "Enter") submit(); if (e.key === "Escape") resume(); };
    ui.mic = btn("mic", "Speak your question", () => listen(submit), "mic");
    const row = el("div", "ask-row");
    row.append(ui.input, ui.mic);
    ui.askStatus = el("p", "ask-status");
    ui.answer = el("div");
    const cont = el("button", "pill", "Continue reading");
    cont.onclick = trusted(resume);
    const more = el("button", "pill ghost", "Ask more");
    more.onclick = trusted(() => listen(submit, "Listening… ask more"));
    const actions = el("div", "actions");
    actions.append(cont, more);
    ui.panel.append(ui.cur, row, ui.askStatus, ui.answer, actions);

    root.append(style, ui.caption, ui.note, ui.list, ui.panel, bar);
    document.documentElement.append(host);
    ui.host = host;

    const hl = el("style");
    hl.id = "lector-style";
    hl.textContent = "::highlight(lector-current){background-color:rgb(255 214 102/.75);color:inherit}";
    document.head.append(hl);
    ui.hl = hl;
    setMode(state.mode);
    renderSections();
  }

  function toggleList() { ui.panel.hidden = true; ui.list.hidden = !ui.list.hidden; if (!ui.list.hidden) renderSections(); }

  function onKey(e) {
    if (!e.isTrusted || !state.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.composedPath()[0];
    if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName)) return;
    const k = e.key;
    if (k === " ") state.playing ? stop() : ui.panel.hidden ? play() : resume();
    else if (k === "ArrowLeft") e.shiftKey ? stepSection(-1) : step(-1);
    else if (k === "ArrowRight") e.shiftKey ? stepSection(1) : step(1);
    else if (k === "a" || k === "A") openAsk();
    else if (k === "s" || k === "S") toggleList();
    else if (k === "m" || k === "M") setMode(state.mode === "narrated" ? "original" : "narrated");
    else if (k === "Escape") !ui.list.hidden ? (ui.list.hidden = true) : ui.panel.hidden ? close() : resume();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  async function open(start) {
    if (!state.open) {
      await loadSettings();
      state.sections = buildSections();
      if (!state.sections.length) { alert("Lector found no readable text on this page."); return; }
      buildUI();
      addEventListener("keydown", onKey, true);
      state.open = true;
    }
    const [k, i] = start || [sectionAtViewport(), 0];
    restartAt(k, i);
  }
  function close() {
    stop();
    try { rec?.abort(); } catch {}
    CSS.highlights?.delete("lector-current");
    ui.host?.remove();
    ui.hl?.remove();
    removeEventListener("keydown", onKey, true);
    Object.assign(state, { open: false, items: null, sec: null, sections: [] });
  }

  // Called by viewer.js: read only the PDF text layers.
  L.setRoot = (root, opts = {}) => { state.root = root; state.pdf = !!opts.pdf; };
  L.command = async (cmd) => {
    if (cmd === "toggle") return state.open ? close() : open();
    if (cmd === "ask") { if (!state.open) await open(); return openAsk(); }
    if (cmd === "fromSelection") {
      if (!state.open) { await loadSettings(); state.sections = buildSections(); }
      return open(positionOfSelection() || undefined);
    }
  };
  L._state = state; // for tests (isolated world only; pages cannot see it)
  L._ui = ui;
  L._collect = collect;
  L._buildSections = buildSections;
  L._speakable = (t) => { if (!lexicon.length) compileLexicon(); return speakable(t); };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.tabId != null && msg.tabId !== L.tabId && L.tabId != null) return;
    if (msg?.type === "lector") L.command(msg.cmd);
    if (msg?.type === "lector-tts-ended") ended(msg.token);
  });
})();
