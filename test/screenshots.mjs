// Makes the landing-page screenshots in docs/img/ from docs/demo.html, with a real Gemini key so the
// captions and the answer are genuine. Chrome runs headless and muted.
//   node test/screenshots.mjs <file holding a Gemini key>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const key = readFileSync(resolve(process.argv[2]), "utf8").trim();
const ext = resolve(new URL("..", import.meta.url).pathname);
const out = resolve(ext, "docs/img");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pdfBytes = null;
const server = createServer((req, res) => {
  if (req.url.startsWith("/demo.pdf") && pdfBytes) return res.writeHead(200, { "content-type": "application/pdf" }).end(pdfBytes);
  if (req.url.startsWith("/demo.html")) return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(resolve(ext, "docs/demo.html")));
  res.writeHead(404).end();
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const profile = "/tmp/lector-shots-profile";
rmSync(profile, { recursive: true, force: true });
const port = 9342;
const chrome = spawn("google-chrome-stable", ["--headless=new", "--disable-gpu", "--mute-audio", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--enable-unsafe-extension-debugging", "--force-device-scale-factor=1", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });

async function json(p) { for (let i = 0; i < 50; i++) { try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).json(); } catch { await sleep(200); } } }
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map(); const contexts = [];
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression, contextId) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) })).result?.result?.value;
  const world = () => contexts.filter((c) => c.auxData?.type === "isolated" && c.name === "Lector").pop()?.id;
  return new Promise((ok) => ws.addEventListener("open", () => ok({ ws, send, ev, world })));
}
const key2 = (page, key, code, modifiers = 0, vk = 0) => page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: vk, text: key.length === 1 ? key : undefined })
  .then(() => page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk }));

try {
  await json("/json/version");
  const browser = await connect((await json("/json/version")).webSocketDebuggerUrl);
  const extId = (await browser.send("Extensions.loadUnpacked", { path: ext })).result.id;
  let sw;
  for (let i = 0; i < 30 && !sw; i++) { sw = (await json("/json")).find((t) => t.type === "service_worker" && t.url.includes(extId)); await sleep(300); }
  const worker = await connect(sw.webSocketDebuggerUrl);
  await worker.ev(`chrome.storage.local.set(${JSON.stringify({ provider: "gemini", geminiKey: key, mode: "narrated", rate: 1 })}).then(() => 1)`);
  const page = await connect((await json("/json")).find((t) => t.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable"); await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => { const s = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}/${name}.png`, Buffer.from(s.result.data, "base64")); console.log("saved", name); };

  // A PDF of the demo page, for the viewer screenshot.
  await page.send("Page.navigate", { url: base + "/demo.html" });
  await sleep(1500);
  pdfBytes = Buffer.from((await page.send("Page.printToPDF", { printBackground: true })).result.data, "base64");

  // 1. Reading a web page in Narrated mode.
  const tabId = await worker.ev(`chrome.tabs.query({}).then(t => t.find(x => x.url.includes('/demo.html')).id)`);
  await worker.ev(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ['src/reader.js'] }).then(() => chrome.tabs.sendMessage(${tabId}, { type: 'lector', cmd: 'toggle' })).then(() => 1)`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await page.ev(`!window.__lector._ui.caption.hidden`, page.world())) break; }
  await sleep(1500);
  await shot("read");

  // 2. The sections list.
  await key2(page, "s", "KeyS");
  await sleep(800);
  await shot("sections");
  await key2(page, "Escape", "Escape", 0, 27);

  // 3. Pause and ask.
  await key2(page, "a", "KeyA");
  await sleep(800);
  await page.ev(`window.__lector._ui.input.focus(), 1`, page.world());
  await page.send("Input.insertText", { text: "Why do leaves look green?" });
  await key2(page, "Enter", "Enter", 0, 13);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await page.ev(`!!window.__lector._ui.answer.querySelector('.a, .err')`, page.world())) break; }
  await sleep(500);
  await shot("ask");

  // 4. A PDF in Lector's viewer.
  await page.send("Page.navigate", { url: `chrome-extension://${extId}/src/viewer.html?file=${encodeURIComponent(base + "/demo.pdf")}` });
  for (let i = 0; i < 30; i++) { await sleep(500); if (await page.ev(`!document.getElementById('read').disabled`)) break; }
  await page.ev(`window.__lector.command('toggle')`);
  for (let i = 0; i < 30; i++) { await sleep(700); if (await page.ev(`!window.__lector._ui.caption.hidden`)) break; }
  await sleep(1500);
  await shot("pdf");
  await worker.ev(`chrome.storage.local.clear().then(() => 1)`);
} finally {
  chrome.kill();
  server.close();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true });
}
