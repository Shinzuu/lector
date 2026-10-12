// Question answering for Lector. Builds a tutor prompt from the passage the reader paused on,
// then calls the provider the user picked in Options. Keys stay in chrome.storage.local.

export const DEFAULTS = {
  provider: "gemini",
  geminiKey: "",
  geminiModel: "gemini-3.5-flash",
  anthropicKey: "",
  anthropicModel: "claude-haiku-4-5-20251001",
  mode: "narrated",
  lexicon: "",
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
    `<coming_next>\n${context.after.join(" ")}\n</coming_next>\n` +
    (context.sectionText ? `<section_source_text>\n${context.sectionText}\n</section_source_text>\n` : "") +
    `</document>`;
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

async function askGemini(s, system, turns, opts = {}) {
  if (!s.geminiKey) throw new Error("No Gemini key. Add one in Lector's Options (free at aistudio.google.com/apikey).");
  const model = encodeURIComponent(s.geminiModel || DEFAULTS.geminiModel);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    generationConfig: { maxOutputTokens: opts.maxTokens || 700, temperature: 0.4, ...(opts.json ? { responseMimeType: "application/json" } : {}) },
  };
  // Flash models think by default, which spends the output budget and adds seconds of silence.
  if (/2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (/gemini-3/.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
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

async function askAnthropic(s, system, turns, opts = {}) {
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
      max_tokens: opts.maxTokens || 700,
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${j.error?.message || r.statusText}`);
  return (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
}

// ---------- narration ----------
const NARRATE_SYSTEM = `You turn lecture slides or web text into a script that a text-to-speech voice reads aloud to a
student revising for an exam. The student is listening, not looking, so the script must make sense by ear.

Keep: every technical point, definition, number, formula, comparison and example in the text. Add no facts
that are not in the text.

Leave out what a listener does not need: course codes, lecturer, department and university names, dates,
page numbers, slide headers and footers, "Outline", "Agenda", "Questions?" and "Thank you" slides, and
figure labels that mean nothing without the picture. If a section has nothing worth saying, return an
empty narration for it.

Say it the way a good teacher would explain it: short, complete sentences, linked with words like "so",
"because", "first", "next" and "in contrast". Turn bullet lists into sentences. Read a table as comparisons,
row by row. Say a formula in words, then what it means in one sentence.

Write every term the way it is spoken, because the voice reads exactly what you write:
- acronyms said as letters get spaces: "H D F S", "O R C", "S Q L", "C P U";
- acronyms said as words are written as words: "Yarn", "NASA", "RAM", "JSON" as "Jason";
- symbols and units in words: "->" as "leads to", "10 TB" as "10 terabytes", "2^10" as "2 to the power 10",
  "O(n log n)" as "order n log n", "e.g." as "for example", "&" as "and", "%" as "percent".

Plain spoken text only: no markdown, no bullet characters, no headings, no emojis, no parentheses for asides.
Length: about as long as the source, never more than twice as long.

Return JSON exactly like {"sections":[{"id":3,"narration":"..."}]}, one entry per input section, same ids.`;

export function buildNarrationPrompt(title, sections) {
  const body = sections.map((s) => `<section id="${s.id}">\n${s.text}\n</section>`).join("\n");
  return { system: NARRATE_SYSTEM, turns: [{ role: "user", text: `<document title="${escapeAttr(title)}">\n${body}\n</document>` }] };
}

export function parseNarration(text, ids) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("narration was not JSON");
  const out = JSON.parse(m[0]).sections;
  if (!Array.isArray(out)) throw new Error("narration JSON had no sections");
  return ids.map((id) => ({ id, narration: String(out.find((x) => Number(x.id) === id)?.narration || "") }));
}

export async function narrate(settings, title, sections) {
  const { system, turns } = buildNarrationPrompt(title, sections);
  const opts = { json: true, maxTokens: 4000 };
  const text = settings.provider === "anthropic" ? await askAnthropic(settings, system, turns, opts) : await askGemini(settings, system, turns, opts);
  return parseNarration(text, sections.map((s) => s.id));
}

export const hasKey = (s) => Boolean(s.provider === "anthropic" ? s.anthropicKey : s.geminiKey);
