<p align="center"><img src="icons/icon.svg" width="96" alt=""></p>
<h1 align="center">Lector</h1>
<p align="center">A Chrome extension that reads web pages and PDFs aloud, highlights each sentence as it goes,<br>
and lets you pause to ask a question about what you just heard.</p>

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Lector, then open its **Options** and paste a free Gemini key from
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (or an Anthropic API key).
4. For PDFs on disk, turn on **Allow access to file URLs** on Lector's card, or use **Open PDF** in the viewer.

## Use

| Key | Does |
|---|---|
| `Alt+Shift+R` or the toolbar icon | Start or stop reading. It starts at the first sentence on screen. |
| `Alt+Shift+A` or `A` | Pause and ask. Speak your question (or type it). The answer is read out. |
| say “continue” | Resume reading where you paused. Anything else you say is a follow-up question. |
| `Space` | Play / pause |
| `←` `→` | Previous / next sentence |
| `Shift+←` `Shift+→` | Previous / next section (a PDF page, or a heading on a web page) |
| `S` | Sections list: untick what to skip, click a title to jump |
| `M` | Switch Narrated / Original |
| right-click → *Lector: read from here* | Start at the selected text |

PDF links open in Lector's own viewer, because Chrome's built-in PDF viewer cannot run extensions.

## Narrated and Original

**Narrated** (default when a key is set): before each section is read, the model rewrites it as a short
spoken explanation, the way a tutor would say it. Course codes, names, dates, page numbers, headers and
footers are dropped; bullets become sentences; tables become comparisons; formulas are said in words; terms
are written as they are spoken ("Yarn", "H D F S", "10 terabytes"). Four pages go in one request, the next
batch is fetched while you listen, and scripts are cached, so a second listen costs nothing. The spoken line
shows as a caption above the bar.

**Original** reads the text as written, but first removes text that repeats on most pages (slide headers,
footers, page numbers) and applies the pronunciation list. Add your own fixes in Options
(`WORD = how to say it`).

## Voice

By default Lector uses Microsoft's neural voices, the ones behind Edge's Read Aloud (Ava, Andrew, Emma,
Brian, Aria, Sonia and more; pick one in Options). They are free, need no account and no Edge browser, and
work on Linux. The next two sentences are fetched while the current one plays, so there are no gaps.

This is an unofficial use of a public endpoint (protocol from the open-source
[edge-tts](https://github.com/rany2/edge-tts) project). It needs internet, and if Microsoft changes it,
Lector switches to Chrome's own voices on its own and says so in the bar.

## How questions work

When you ask, Lector sends the model the document title, the last ~30 sentences you heard, the current
sentence and the next 5, plus your earlier questions from the same pause. The model is told to answer
from the passage first, to say when it is going beyond it, and to keep the answer short and speakable.

Keys live only in `chrome.storage.local` and go only to the provider you pick. A Claude Code or
claude.ai login cannot be used: those are subscription logins, not API keys.

## Develop

```bash
node --test test/*.test.mjs                 # prompt + provider request shapes (fetch mocked)
node test/e2e.mjs some.pdf some.html        # headless Chrome: viewer, web page, ask round trip
```

The microphone uses Chrome's Web Speech API (audio goes to Google for recognition). pdf.js 4.10.38 is vendored in `vendor/pdfjs`
(Apache-2.0).
