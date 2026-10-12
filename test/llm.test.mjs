// Unit tests for the prompt builder and both provider request shapes, with fetch mocked.
//   node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, ask, DEFAULTS } from "../src/llm.js";

const ctx = { title: "W05 HDFS", url: "https://x/y.pdf", before: ["HDFS stores files."], current: "Blocks are 128 MB.", after: ["Replication is 3."] };

test("first question carries the passage, follow-ups do not repeat it", () => {
  const one = buildPrompt("why 128?", ctx);
  assert.equal(one.turns.length, 1);
  assert.match(one.turns[0].text, /<current_sentence>\nBlocks are 128 MB\.\n<\/current_sentence>/);
  assert.match(one.turns[0].text, /why 128\?$/);
  const two = buildPrompt("and replication?", ctx, [{ q: "why 128?", a: "Fewer seeks." }]);
  assert.deepEqual(two.turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.match(two.turns[0].text, /<document/);
  assert.equal(two.turns[2].text, "and replication?");
  assert.match(one.system, /read aloud/);
});

test("document title is escaped inside the attribute", () => {
  const p = buildPrompt("q", { ...ctx, title: 'A "quoted" <b>' });
  assert.match(p.turns[0].text, /title="A &quot;quoted&quot; &lt;b>"/);
});

function mockFetch(response, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status, statusText: "x", json: async () => response }; };
  return calls;
}

test("gemini request: key in header, system instruction, thinking off for 2.5 flash", async () => {
  const calls = mockFetch({ candidates: [{ content: { parts: [{ text: "Fewer seeks." }] } }] });
  const a = await ask({ ...DEFAULTS, geminiKey: "K" }, "why?", ctx, []);
  assert.equal(a, "Fewer seeks.");
  assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "K");
  assert.ok(!calls[0].url.includes("K"), "key must not be in the URL");
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(calls[0].body.contents[0].role, "user");
});

test("anthropic request: headers and message shape", async () => {
  const calls = mockFetch({ content: [{ type: "text", text: "Because." }] });
  const a = await ask({ ...DEFAULTS, provider: "anthropic", anthropicKey: "S" }, "why?", ctx, [{ q: "a", a: "b" }]);
  assert.equal(a, "Because.");
  assert.equal(calls[0].init.headers["x-api-key"], "S");
  assert.equal(calls[0].init.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.deepEqual(calls[0].body.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(calls[0].body.model, DEFAULTS.anthropicModel);
});

test("missing key and API errors give readable messages", async () => {
  await assert.rejects(ask({ ...DEFAULTS }, "q", ctx), /No Gemini key/);
  mockFetch({ error: { message: "API key not valid" } }, 400);
  await assert.rejects(ask({ ...DEFAULTS, geminiKey: "bad" }, "q", ctx), /Gemini 400: API key not valid/);
});
