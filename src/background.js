import { DEFAULTS, ask, narrate, hasKey } from "./llm.js";
import { installHeaderRule } from "./edge-tts.js";

const VIEWER = chrome.runtime.getURL("src/viewer.html");
const isPdfUrl = (u) => /^(https?|file):.*\.pdf([?#].*)?$/i.test(u || "");
const viewerFor = (u) => VIEWER + "?file=" + encodeURIComponent(u);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "read-from-here", title: "Lector: read from here", contexts: ["selection", "page"] });
  chrome.contextMenus.create({ id: "open-pdf", title: "Lector: open this PDF", contexts: ["link"], targetUrlPatterns: ["*://*/*.pdf*", "file:///*.pdf*"] });
});

// Inject the reader into a normal page (or open a PDF in Lector's own viewer), then send it a command.
async function command(tab, cmd) {
  if (!tab?.id) return;
  if (tab.url?.startsWith(VIEWER)) return chrome.runtime.sendMessage({ type: "lector", cmd, tabId: tab.id }).catch(() => {});
  if (isPdfUrl(tab.url)) return chrome.tabs.update(tab.id, { url: viewerFor(tab.url) });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/reader.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "lector", cmd });
  } catch (e) {
    console.warn("Lector cannot run on this page:", e.message); // chrome:// pages, the Web Store, etc.
  }
}

chrome.action.onClicked.addListener((tab) => command(tab, "toggle"));
chrome.commands.onCommand.addListener(async (name, tab) => {
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (name === "ask") command(tab, "ask");
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-pdf") chrome.tabs.create({ url: viewerFor(info.linkUrl) });
  if (info.menuItemId === "read-from-here") command(tab, "fromSelection");
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "ask") {
    chrome.storage.local.get(DEFAULTS).then((s) =>
      ask(s, msg.question, msg.context, msg.history).then(
        (answer) => reply({ answer }),
        (e) => reply({ error: e.message }),
      ),
    );
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === "settings") {
    chrome.storage.local.get(DEFAULTS).then((s) => reply({ engine: s.engine, voiceURI: s.voiceURI, rate: s.rate, speakAnswers: s.speakAnswers, mode: s.mode, lexicon: s.lexicon, hasKey: hasKey(s) }));
    return true;
  }
  if (msg?.type === "narrate") { narrateCached(msg).then(reply, (e) => reply({ error: e.message })); return true; }
  if (msg?.type === "tts") { speak(msg, _sender).then(reply, (e) => reply({ error: e.message })); return true; }
  if (msg?.type === "tts-stop") { if (!playing || playing.token <= msg.token) playing = null; offscreen({ type: "stop", token: msg.token }, { create: false }).catch(() => {}); }
  if (msg?.type === "tts-ended" && playing && msg.token === playing.token) {
    const { tabId, viewer, token } = playing;
    playing = null;
    const out = { type: "lector-tts-ended", token, tabId };
    (viewer ? chrome.runtime.sendMessage(out) : chrome.tabs.sendMessage(tabId, out)).catch(() => {});
  }
  if (msg?.type === "options") chrome.runtime.openOptionsPage();
});

// ---------- narration ----------
// Scripts are cached by a hash of the model and section text, so re-listening costs no API calls.
async function cacheKey(model, text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(model + "\n" + text));
  return "narr1:" + [...new Uint8Array(h)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function narrateCached(msg) {
  const s = await chrome.storage.local.get(DEFAULTS);
  if (!hasKey(s)) throw new Error("no API key");
  const model = s.provider === "anthropic" ? s.anthropicModel : s.geminiModel;
  const keys = await Promise.all(msg.sections.map((x) => cacheKey(model, x.text)));
  const cached = await chrome.storage.local.get(keys);
  const missing = msg.sections.filter((_, i) => cached[keys[i]] == null);
  if (missing.length) {
    const fresh = await narrate(s, msg.title, missing);
    const put = {};
    for (const f of fresh) put[keys[msg.sections.findIndex((x) => x.id === f.id)]] = f.narration;
    await chrome.storage.local.set(put);
    Object.assign(cached, put);
  }
  return { sections: msg.sections.map((x, i) => ({ id: x.id, narration: cached[keys[i]] || "" })) };
}

// ---------- neural voice ----------
// The reader sends one sentence at a time plus the next couple; the offscreen page fetches, caches and plays.
let playing = null; // { tabId, viewer, token }
let ruleReady = null;

let docReady = null;
async function offscreen(msg, { create = true } = {}) {
  ruleReady ||= installHeaderRule();
  await ruleReady;
  if (!(await chrome.offscreen.hasDocument())) {
    if (!create) return { ok: true };
    // One shared promise: two messages arriving together must not both try to create the document.
    docReady ||= chrome.offscreen.createDocument({ url: "src/offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "Play the read-aloud voice" })
      .finally(() => (docReady = null));
    await docReady;
  }
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

async function speak(msg, sender) {
  const s = await chrome.storage.local.get(DEFAULTS);
  const tabId = sender.tab?.id ?? msg.tabId;
  playing = { tabId, viewer: !sender.tab || sender.url?.startsWith(VIEWER), token: msg.token };
  const r = await offscreen({ type: "play", text: msg.text, next: msg.next || [], voice: s.edgeVoice, rate: msg.rate || s.rate, token: msg.token });
  if (r?.error) throw new Error(r.error);
  return { ok: true };
}
