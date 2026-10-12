import { DEFAULTS } from "./llm.js";
import { EDGE_VOICES } from "./edge-tts.js";

const $ = (id) => document.getElementById(id);
const fields = ["geminiKey", "geminiModel", "anthropicKey", "anthropicModel", "edgeVoice", "voiceURI", "rate", "speakAnswers", "lexicon"];

function showProvider(p) {
  $("gemini").hidden = p !== "gemini";
  $("anthropic").hidden = p !== "anthropic";
}

function showEngine(e) {
  $("edgeBox").hidden = e !== "edge";
  $("browserBox").hidden = e !== "browser";
}
$("edgeVoice").replaceChildren(...EDGE_VOICES.map(([id, label]) => new Option(label, id)));

function fillVoices(selected) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")).sort((a, b) => a.name.localeCompare(b.name));
  $("voiceURI").replaceChildren(
    new Option("Automatic (best English voice)", ""),
    ...voices.map((v) => new Option(`${v.name} (${v.lang})${v.localService ? "" : " · online"}`, v.voiceURI)),
  );
  $("voiceURI").value = selected || "";
}

const s = await chrome.storage.local.get(DEFAULTS);
document.querySelector(`input[name=provider][value=${s.provider}]`).checked = true;
showProvider(s.provider);
document.querySelector(`input[name=engine][value=${s.engine}]`).checked = true;
showEngine(s.engine);
document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
document.querySelectorAll("input[name=engine]").forEach((r) => (r.onchange = () => showEngine(r.value)));
for (const f of fields) {
  if (f === "speakAnswers") $(f).checked = s[f];
  else if (f !== "voiceURI") $(f).value = s[f];
}
$("rateOut").textContent = s.rate + "×";
fillVoices(s.voiceURI);
speechSynthesis.onvoiceschanged = () => fillVoices($("voiceURI").value || s.voiceURI);

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = () => showProvider(r.value)));
$("rate").oninput = () => ($("rateOut").textContent = $("rate").value + "×");
const SAMPLE = "HDFS splits each file into 128 megabyte blocks and stores three replicas of each one.";
$("test").onclick = async () => {
  if (document.querySelector("input[name=engine]:checked").value === "edge") {
    await chrome.storage.local.set({ edgeVoice: $("edgeVoice").value });
    const r = await chrome.runtime.sendMessage({ type: "tts", text: SAMPLE, token: Date.now(), rate: Number($("rate").value) });
    if (r?.error) $("saved").textContent = "Neural voice failed: " + r.error;
    return;
  }
  const u = new SpeechSynthesisUtterance(SAMPLE);
  const v = speechSynthesis.getVoices().find((v) => v.voiceURI === $("voiceURI").value);
  if (v) u.voice = v;
  u.rate = Number($("rate").value);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
};
$("save").onclick = async () => {
  const out = { provider: document.querySelector("input[name=provider]:checked").value, engine: document.querySelector("input[name=engine]:checked").value, mode: document.querySelector("input[name=mode]:checked").value };
  for (const f of fields) out[f] = f === "speakAnswers" ? $(f).checked : f === "rate" ? Number($(f).value) : f === "lexicon" ? $(f).value : $(f).value.trim();
  await chrome.storage.local.set(out);
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
};
