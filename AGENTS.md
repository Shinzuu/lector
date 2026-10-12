# AGENTS.md

Guide for coding agents working on Lector, or installing it for someone.

Lector is a Chrome MV3 extension (no build step, no dependencies) that reads web pages and PDFs aloud
with Microsoft's neural voices, rewrites slides into spoken explanations with Gemini or Claude
("Narrated" mode), and answers questions when the listener pauses.

## Repo layout

| Path | What |
|---|---|
| `manifest.json` | MV3 manifest. Commands: `Alt+Shift+R` start/stop, `Alt+Shift+A` ask. |
| `src/background.js` | Service worker: injects the reader, routes ask/narrate/TTS messages, caches narration. |
| `src/reader.js` | Content script: sections, sentence highlighting, the bar (closed shadow root), keys, ask panel. |
| `src/llm.js` | `DEFAULTS` for every setting, prompt builders, Gemini and Anthropic calls. |
| `src/edge-tts.js`, `src/offscreen.*` | Neural voice over the Edge read-aloud endpoint; audio plays in an offscreen page. |
| `src/viewer.*` | Lector's own PDF viewer (pdf.js 4.10.38, vendored in `vendor/pdfjs`). |
| `src/options.*` | Settings page; writes `chrome.storage.local`. |
| `test/` | `llm.test.mjs` (unit, fetch mocked), `e2e.mjs` (headless Chrome), `screenshots.mjs`. |
| `scripts/` | Local helpers, e.g. loading Lector into a Playwright profile. |
| `docs/` | GitHub Pages site. `agent-setup.html` and `agent-setup-prompt.md` are the agent install guide. |

## Installing Lector for a user

Follow [`docs/agent-setup-prompt.md`](docs/agent-setup-prompt.md); it is written to be pasted into an
agent as is. In short:

- Unzip the [release](https://github.com/Shinzuu/lector/releases/latest/download/lector.zip) to
  `~/lector` (Windows `%USERPROFILE%\lector`) and keep that folder.
- A lasting install needs the human: Developer mode, Load unpacked on `chrome://extensions`, pick the
  folder. Branded Chrome ignores `--load-extension` (v137+), and `Extensions.loadUnpacked` over CDP
  (with `--enable-unsafe-extension-debugging`) lasts one session only: Chrome drops it on restart, which
  is fine for tests but not for users. Chrome also refuses `--remote-debugging-port` on the default
  data directory, so an everyday profile can't be scripted at all; the human pastes the key in Options.
- The only setting that needs writing is `geminiKey`; `provider: "gemini"` and `mode: "narrated"` are
  the defaults. Write settings from the extension's options page context, never by editing profile files.
- Ask before closing the user's browser. Touch no other extension, and never call `Extensions.uninstall`
  or `chrome.runtime.reload()` on Lector: the first wipes its storage, the second unloads it.

## Tests

```bash
node --test test/*.test.mjs                 # unit: prompts and provider requests, fetch mocked
node test/e2e.mjs some.pdf some.html        # headless, muted Chrome with Lector loaded over CDP
```

`e2e.mjs` uses a throwaway profile in `/tmp/lector-e2e-profile` and a deliberately invalid Gemini key.
Node 22+ (global `WebSocket`) and `google-chrome-stable` are required.

## Rules

- Tests and checks run headless with `--mute-audio` in a throwaway `--user-data-dir` under `/tmp`.
  Never point them at a real profile, and never play sound: the owner is often listening to something.
- Never commit, print or log an API key. Use fake keys such as `test-key` in tests; real keys live
  only in the user's `chrome.storage.local`.
- Keep it dependency-free and buildless: plain ES modules loaded directly by Chrome.
- Text Lector speaks must stay speakable (no markdown, symbols said in words); see the prompts in `src/llm.js`.
