// Question answering for Lector. Builds a tutor prompt from the passage the reader paused on,
// then calls the provider the user picked in Options. Keys stay in chrome.storage.local.

export const DEFAULTS = {
  provider: "gemini",
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  anthropicKey: "",
  anthropicModel: "claude-haiku-4-5-20251001",
  engine: "edge",
  edgeVoice: "en-US-AvaMultilingualNeural",
  voiceURI: "",
  rate: 1.1,
  speakAnswers: true,
};

const SYSTEM = `You are a study tutor built into a read-aloud tool. The student is listening to a document,
paused it, and asked a question about what they just heard.

Answer from the passage first. If the passage does not cover it, answer from general knowledge and say
"the text doesn't cover this, but". When they say "this", "it" or "that", they mean the current sentence.

Your answer is read aloud by a text-to-speech voice, so write plain spoken sentences: no markdown, no
bullet points, no headings, no code blocks, no symbols that sound odd when spoken. Keep it to 2 to 5
short sentences unless they ask for more detail or an example. If they are studying for an exam, end
with the one fact worth remembering.`;

// context: { title, url, before: [..], current, after: [..] }; history: [{q, a}]
export function buildPrompt(question, context, history = []) {
  const passage =
    `<document title="${escapeAttr(context.title)}" url="${escapeAttr(context.url)}">\n` +
    `<heard_before>\n${context.before.join(" ")}\n</heard_before>\n` +
    `<current_sentence>\n${context.current}\n</current_sentence>\n` +
    `<coming_next>\n${context.after.join(" ")}\n</coming_next>\n</document>`;
  const turns = [];
  history.forEach((h, i) => {
    turns.push({ role: "user", text: (i === 0 ? passage + "\n\n" : "") + h.q });
    turns.push({ role: "assistant", text: h.a });
  });
  turns.push({ role: "user", text: (history.length ? "" : passage + "\n\n") + question });
  return { system: SYSTEM, turns };
}

function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export async function ask(settings, question, context, history) {
  const { system, turns } = buildPrompt(question, context, history);
  if (settings.provider === "anthropic") return askAnthropic(settings, system, turns);
  return askGemini(settings, system, turns);
}

async function askGemini(s, system, turns) {
  if (!s.geminiKey) throw new Error("No Gemini key. Add one in Lector's Options (free at aistudio.google.com/apikey).");
  const model = encodeURIComponent(s.geminiModel || DEFAULTS.geminiModel);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    generationConfig: { maxOutputTokens: 700, temperature: 0.4 },
  };
  // 2.5 Flash thinks by default, which spends the output budget and adds seconds of silence.
  if (/2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message || r.statusText}`);
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no answer (" + (j.candidates?.[0]?.finishReason || "empty") + ").");
  return text;
}

async function askAnthropic(s, system, turns) {
  if (!s.anthropicKey) throw new Error("No Anthropic API key. Add one in Lector's Options.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": s.anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: s.anthropicModel || DEFAULTS.anthropicModel,
      max_tokens: 700,
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${j.error?.message || r.statusText}`);
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}
