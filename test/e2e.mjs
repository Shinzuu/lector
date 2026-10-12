// End-to-end check in headless Chrome with the unpacked extension loaded.
//   node test/e2e.mjs <some.pdf> <some.html> [screenshot dir]
// Serves both files over local HTTP, then:
//   1. opens the PDF in Lector's viewer and checks the text layer splits into sentences;
//   2. injects the reader into the web page the way the toolbar button does, checks the bar, highlight
//      and sentence count;
//   3. asks a typed question with a deliberately invalid Gemini key, which exercises the whole path
//      (panel -> service worker -> real Gemini endpoint -> error shown in the panel).
// Speech itself cannot be heard in headless Chrome, so it is not asserted.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, basename } from "node:path";

const [pdfPath, htmlPath, shots = "/tmp/lector-e2e"] = process.argv.slice(2).map((p) => resolve(p));
mkdirSync(shots, { recursive: true });
const ext = resolve(new URL("..", import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const files = { "/doc.pdf": [pdfPath, "application/pdf"], "/page.html": [htmlPath, "text/html"] };
const server = createServer((req, res) => {
  const f = files[req.url.split("?")[0]];
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": f[1] }).end(readFileSync(f[0]));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const profile = "/tmp/lector-e2e-profile";
rmSync(profile, { recursive: true, force: true });
const port = 9341;
const chrome = spawn("google-chrome-stable", ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--enable-unsafe-extension-debugging", "--mute-audio", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

async function targets() { for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } } }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const contexts = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
    if (m.method === "Runtime.executionContextsCleared") contexts.length = 0;
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression, contextId) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
    return r.result?.result?.value;
  };
  // The reader's panel is a closed shadow root, so tests talk to it from Lector's isolated world.
  const lectorWorld = () => contexts.filter((c) => c.auxData?.type === "isolated" && c.name === "Lector").pop()?.id;
  return new Promise((ok) => ws.addEventListener("open", () => ok({ ws, send, evaluate, lectorWorld })));
}

const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

try {
  // Branded Chrome ignores --load-extension since v137, so load it over CDP instead.
  await targets();
  const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const browser = await connect(browserWs);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: ext });
  if (loaded.error) throw new Error("loadUnpacked: " + loaded.error.message);
  let list = await targets();
  let sw;
  for (let i = 0; i < 30 && !sw; i++) { sw = list.find((t) => t.type === "service_worker" && t.url.includes("background.js")); if (!sw) { await sleep(300); list = await targets(); } }
  check("extension service worker started", !!sw);
  const extId = new URL(sw.url).host;
  const worker = await connect(sw.webSocketDebuggerUrl);
  const page = await connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const shot = async (name) => { const s = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${shots}/${name}.png`, Buffer.from(s.result.data, "base64")); };

  // 1. PDF viewer
  await page.send("Page.navigate", { url: `chrome-extension://${extId}/src/viewer.html?file=${encodeURIComponent(base + "/doc.pdf")}` });
  let pdfInfo;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    pdfInfo = await page.evaluate(`(() => ({ pages: document.querySelectorAll('.page').length, ready: !document.getElementById('read').disabled,
      err: document.querySelector('.error')?.textContent || '' }))()`).catch(() => null);
    if (pdfInfo?.ready || pdfInfo?.err) break;
  }
  check("PDF opens in the viewer", pdfInfo?.ready, `${pdfInfo?.pages} pages ${pdfInfo?.err}`);
  const pdfSent = await page.evaluate(`(() => { const s = window.__lector._collect(); return { n: s.length, sample: s.slice(0, 6).map(x => x.text), long: s.filter(x => x.text.length > 270).length }; })()`);
  check("PDF text splits into sentences", pdfSent.n > 20, `${pdfSent.n} sentences, ${pdfSent.long} over 270 chars`);
  console.log("      first sentences:", JSON.stringify(pdfSent.sample, null, 0).slice(0, 400));
  const secInfo = await page.evaluate(`(() => { const secs = window.__lector._buildSections(); const texts = secs.flatMap(s => s.items.map(x => x.text));
    return { n: secs.length, footerTexts: texts.filter(t => /Dept\\. of CSE|Spring 2026|^\\d+ \\/ \\d+$/.test(t)), footer: texts.filter(t => /Dept\\. of CSE|Spring 2026|^\\d+ \\/ \\d+$/.test(t)).length, titles: secs.slice(1, 4).map(s => s.title),
      say: window.__lector._speakable('YARN stores 10 TB, e.g. in HDFS → fast') }; })()`);
  check("PDF: one section per page, repeated headers/footers removed", secInfo.n >= 30 && secInfo.footer <= 1, `${secInfo.n} sections, ${secInfo.footer} footer lines left ${JSON.stringify(secInfo.footerTexts)}, e.g. ${JSON.stringify(secInfo.titles)}`);
  check("pronunciation fixes applied", secInfo.say === "Yarn stores 10 terabytes, for example in H D F S leads to fast", secInfo.say);
  await page.evaluate(`window.__lector.command('toggle')`);
  await sleep(800);
  const pdfUi = await page.evaluate(`(() => ({ bar: !!window.__lector._ui.host?.isConnected,
    status: window.__lector._ui.status?.textContent, hl: CSS.highlights.has('lector-current') }))()`);
  check("PDF: reader bar and highlight appear", pdfUi.bar && pdfUi.hl, `status "${pdfUi.status}"`);
  let voice;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    voice = await page.evaluate(`({ idx: window.__lector._state.heard.length, down: !!window.__lector._state.edgeDown })`);
    if (voice.idx >= 3 || voice.down) break;
  }
  voice = await page.evaluate(`({ idx: window.__lector._state.heard.length, down: !!window.__lector._state.edgeDown, engine: window.__lector._state.settings.engine, err: window.__lector._state.edgeError })`);
  const off = (await targets()).find((t) => t.url.includes("offscreen.html"));
  if (off) { const o = await connect(off.webSocketDebuggerUrl); console.log("      offscreen audio:", await o.evaluate(`JSON.stringify({ t: __audio.currentTime, d: __audio.duration, paused: __audio.paused, ended: __audio.ended, err: __audio.error?.message })`)); o.ws.close(); }
  const neuralLine = "neural voice plays and advances sentence by sentence";
  check(neuralLine, voice.engine === "edge" && !voice.down && voice.idx >= 3, JSON.stringify(voice));
  const skip = await page.evaluate(`(async () => { const st = window.__lector._state; st.sections[1].skip = true; st.sections[2].skip = true;
    st.sec = 0; st.items = null; window.__lector._ui.host; document.dispatchEvent(new Event('noop'));
    return 1; })()`);
  // Next section from page 1 must land on page 4 because pages 2 and 3 are skipped (Shift+Right is a trusted key event).
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", modifiers: 8, windowsVirtualKeyCode: 39 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", modifiers: 8, windowsVirtualKeyCode: 39 });
  await sleep(1500);
  const after = await page.evaluate(`window.__lector._state.sections[window.__lector._state.sec].label`);
  check("next section skips unticked sections", after === "Page 4", after);
  await shot("1-pdf-reading");

  // 2. Web page via the same path as the toolbar button
  await page.send("Page.navigate", { url: base + "/page.html" });
  await sleep(2000);
  const tabId = await worker.evaluate(`chrome.tabs.query({}).then(t => t.find(x => x.url.includes('/page.html')).id)`);
  await worker.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['src/reader.js'] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: 'lector', cmd: 'toggle' })).then(() => 1)`);
  await sleep(1500);
  const iso = page.lectorWorld();
  const webUi = await page.evaluate(`(() => { const u = window.__lector._ui; return { bar: !!u.host?.isConnected,
    status: u.status?.textContent || '', hl: CSS.highlights.has('lector-current') }; })()`, iso);
  const leak = await page.evaluate(`({ shadow: document.getElementById('lector-host')?.shadowRoot === null, api: typeof window.__lector })`);
  check("page scripts cannot reach the panel or reader", leak.shadow && leak.api === "undefined", JSON.stringify(leak));
  const total = Number((webUi.status.split("/")[1] || "0").trim());
  check("web page: reader bar appears with sentences", webUi.bar && total > 20, `status "${webUi.status}", highlight ${webUi.hl}`);
  await shot("2-web-reading");

  // 3. Ask with an invalid key: real request to Gemini, error must come back to the panel.
  await worker.evaluate(`chrome.storage.local.set({ provider: 'gemini', geminiKey: 'invalid-test-key' }).then(() => 1)`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await sleep(700);
  await page.evaluate(`window.__lector._ui.input.focus(), 1`, iso);
  await page.send("Input.insertText", { text: "Why is this like this?" });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  let askOut = {};
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    askOut = await page.evaluate(`(() => { const u = window.__lector._ui; return { open: !u.panel.hidden,
      cur: u.cur.textContent.slice(0, 80), q: u.answer.querySelector('.q')?.textContent, err: u.answer.querySelector('.err')?.textContent, a: u.answer.querySelector('.a')?.textContent }; })()`, iso);
    if (askOut.err || askOut.a) break;
  }
  check("ask: panel opens on A, shows the current sentence", askOut.open && askOut.cur.length > 3, askOut.cur);
  check("ask: question reaches Gemini and the API error is shown", /Gemini 4\d\d/.test(askOut.err || ""), askOut.err || askOut.a || "no reply");
  await shot("3-ask-panel");
  // Narrated mode with a bad key: narration fails, Lector says so and keeps reading the original text.
  await worker.evaluate(`chrome.storage.local.set({ mode: 'narrated' }).then(() => 1)`);
  await page.send("Page.navigate", { url: `chrome-extension://${extId}/src/viewer.html?file=${encodeURIComponent(base + "/doc.pdf")}` });
  for (let i = 0; i < 40; i++) { await sleep(500); if (await page.evaluate(`!document.getElementById('read').disabled`).catch(() => false)) break; }
  await page.evaluate(`window.__lector.command('toggle')`);
  let nar = {};
  for (let i = 0; i < 20; i++) {
    await sleep(800);
    nar = await page.evaluate(`({ mode: window.__lector._state.mode, heard: window.__lector._state.heard.length, note: window.__lector._ui.note.hidden ? '' : window.__lector._ui.note.textContent })`);
    if (nar.heard >= 2) break;
  }
  check("narrated mode with a bad key falls back to the original text and keeps reading", nar.mode === "narrated" && nar.heard >= 1, JSON.stringify(nar).slice(0, 200));
  await worker.evaluate(`chrome.storage.local.clear().then(() => 1)`);
} catch (e) {
  check("run without exceptions", false, e.message);
} finally {
  chrome.kill();
  server.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${shots}`);
  process.exit(failed ? 1 : 0);
}
