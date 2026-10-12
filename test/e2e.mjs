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
  "--enable-unsafe-extension-debugging", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

async function targets() { for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } } }
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
    return r.result?.result?.value;
  };
  return new Promise((ok) => ws.addEventListener("open", () => ok({ ws, send, evaluate })));
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
  await page.evaluate(`window.__lector.command('toggle')`);
  await sleep(800);
  const pdfUi = await page.evaluate(`(() => ({ bar: !!document.getElementById('lector-host')?.shadowRoot?.querySelector('.bar'),
    status: document.getElementById('lector-host')?.shadowRoot?.querySelector('.status')?.textContent, hl: CSS.highlights.has('lector-current') }))()`);
  check("PDF: reader bar and highlight appear", pdfUi.bar && pdfUi.hl, `status "${pdfUi.status}"`);
  await shot("1-pdf-reading");

  // 2. Web page via the same path as the toolbar button
  await page.send("Page.navigate", { url: base + "/page.html" });
  await sleep(2000);
  const tabId = await worker.evaluate(`chrome.tabs.query({}).then(t => t.find(x => x.url.includes('/page.html')).id)`);
  await worker.evaluate(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['src/reader.js'] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: 'lector', cmd: 'toggle' })).then(() => 1)`);
  await sleep(1500);
  const webUi = await page.evaluate(`(() => { const r = document.getElementById('lector-host')?.shadowRoot; return { bar: !!r?.querySelector('.bar'),
    status: r?.querySelector('.status')?.textContent || '', hl: CSS.highlights.has('lector-current') }; })()`);
  const total = Number((webUi.status.split("/")[1] || "0").trim());
  check("web page: reader bar appears with sentences", webUi.bar && total > 20, `status "${webUi.status}", highlight ${webUi.hl}`);
  await shot("2-web-reading");

  // 3. Ask with an invalid key: real request to Gemini, error must come back to the panel.
  await worker.evaluate(`chrome.storage.local.set({ provider: 'gemini', geminiKey: 'invalid-test-key' }).then(() => 1)`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await sleep(700);
  await page.evaluate(`(() => { const r = document.getElementById('lector-host').shadowRoot; const i = r.querySelector('input');
    i.value = 'Why is this like this?'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  let askOut = {};
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    askOut = await page.evaluate(`(() => { const r = document.getElementById('lector-host').shadowRoot; return { open: !r.querySelector('.panel').hidden,
      cur: r.querySelector('.cur').textContent.slice(0, 80), q: r.querySelector('.q')?.textContent, err: r.querySelector('.err')?.textContent, a: r.querySelector('.a')?.textContent }; })()`);
    if (askOut.err || askOut.a) break;
  }
  check("ask: panel opens on A, shows the current sentence", askOut.open && askOut.cur.length > 3, askOut.cur);
  check("ask: question reaches Gemini and the API error is shown", /Gemini 4\d\d/.test(askOut.err || ""), askOut.err || askOut.a || "no reply");
  await shot("3-ask-panel");
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
