// Hidden page that fetches and plays the neural voice. It runs here rather than in the service worker
// because Chrome applies Lector's header rule (see edge-tts.js) to extension pages but not to the worker,
// and playing here also sidesteps each website's autoplay and CSP rules.
import { synthesize } from "./edge-tts.js";

const audio = new Audio();
window.__audio = audio; // inspectable from DevTools
const cache = new Map(); // "voice|rate|text" -> Promise<blob URL>
let current = null;

function audioFor(text, voice, rate) {
  const key = voice + "|" + rate + "|" + text;
  if (!cache.has(key)) {
    const p = synthesize(text, voice, rate).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 40) {
      const [oldKey, old] = cache.entries().next().value;
      cache.delete(oldKey);
      old.then((u) => URL.revokeObjectURL(u), () => {});
    }
  }
  return cache.get(key);
}

audio.onended = () => current != null && chrome.runtime.sendMessage({ type: "tts-ended", token: current });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "play") {
    current = msg.token;
    const { voice, rate } = msg;
    audioFor(msg.text, voice, rate)
      .then((url) => {
        for (const t of msg.next || []) audioFor(t, voice, rate).catch(() => {}); // fetch ahead so there is no gap
        if (current !== msg.token) return reply({ ok: true, skipped: true });
        audio.src = url;
        return audio.play().then(() => reply({ ok: true }));
      })
      .catch((e) => reply({ error: e.message }));
    return true;
  }
  if (msg.type === "stop") {
    // A stop can arrive after the play that followed it; ignore stops older than what is playing.
    if (current != null && msg.token != null && current > msg.token) return reply({ ok: true, stale: true });
    current = null;
    audio.pause();
    reply({ ok: true });
  }
});
