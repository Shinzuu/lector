import { DEFAULTS } from "./llm.js";

const $ = (id) => document.getElementById(id);
const fields = ["geminiKey", "geminiModel", "anthropicKey", "anthropicModel", "voiceURI", "rate", "speakAnswers"];

function showProvider(p) {
  $("gemini").hidden = p !== "gemini";
  $("anthropic").hidden = p !== "anthropic";
}

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
for (const f of fields) {
  if (f === "speakAnswers") $(f).checked = s[f];
  else if (f !== "voiceURI") $(f).value = s[f];
}
$("rateOut").textContent = s.rate + "×";
fillVoices(s.voiceURI);
speechSynthesis.onvoiceschanged = () => fillVoices($("voiceURI").value || s.voiceURI);

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = () => showProvider(r.value)));
$("rate").oninput = () => ($("rateOut").textContent = $("rate").value + "×");
$("test").onclick = () => {
  const u = new SpeechSynthesisUtterance("HDFS splits each file into 128 megabyte blocks and stores three replicas of each one.");
  const v = speechSynthesis.getVoices().find((v) => v.voiceURI === $("voiceURI").value);
  if (v) u.voice = v;
  u.rate = Number($("rate").value);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
};
$("save").onclick = async () => {
  const out = { provider: document.querySelector("input[name=provider]:checked").value };
  for (const f of fields) out[f] = f === "speakAnswers" ? $(f).checked : f === "rate" ? Number($(f).value) : $(f).value.trim();
  await chrome.storage.local.set(out);
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
};
