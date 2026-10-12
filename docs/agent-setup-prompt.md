Install and set up the Lector Chrome extension for me on this computer. Everything you need is below. Ask me only for the things you cannot do yourself.

<context>
Lector is a free, open-source (MIT) Chrome extension that reads web pages and PDFs aloud. With a Gemini API key it also explains slides in a tutor's voice ("Narrated" mode) and answers spoken questions.

- Code: https://github.com/Shinzuu/lector
- Release zip: https://github.com/Shinzuu/lector/releases/latest/download/lector.zip (it unzips to a folder named `lector` with `manifest.json` directly inside)
- Manual setup steps, to cross-check: https://github.com/Shinzuu/lector#set-up
- Settings live in the extension's `chrome.storage.local`. The ones that matter here are `provider` ("gemini" or "anthropic"), `geminiKey` and `mode` ("narrated" or "original"). The defaults are already provider "gemini" and mode "narrated", so the only value that has to be saved is the key.
- A Gemini key is free at https://aistudio.google.com/apikey (Google sign-in needed). Valid keys start with `AIza` and are 39 characters long.

Facts about Chrome that decide how this goes (tested on Chrome 155):
1. A lasting install of an extension from a folder needs a human: chrome://extensions, Developer mode, Load unpacked, then picking the folder in the operating system's folder picker. Automation cannot drive that picker, and nothing else works:
   - branded Chrome ignores `--load-extension` (since version 137);
   - the DevTools method `Extensions.loadUnpacked` (with `--enable-unsafe-extension-debugging`) loads it for the current session only, and Chrome removes it on the next restart;
   - a synthetic folder drop onto chrome://extensions does nothing.
2. Chrome refuses `--remote-debugging-port` when the profile lives in the browser's default data directory ("DevTools remote debugging requires a non-default data directory"). Default directories:
   - Linux: `~/.config/google-chrome` (Chromium `~/.config/chromium`, Edge `~/.config/microsoft-edge`, Brave `~/.config/BraveSoftware/Brave-Browser`)
   - macOS: `~/Library/Application Support/Google/Chrome` (Edge `.../Microsoft Edge`, Brave `.../BraveSoftware/Brave-Browser`)
   - Windows: `%LOCALAPPDATA%\Google\Chrome\User Data` (Edge `%LOCALAPPDATA%\Microsoft\Edge\User Data`, Brave `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data`)
   So for an everyday profile you cannot script the browser at all; I paste the key into Lector's Options page myself. Only a profile in a custom `--user-data-dir` can be scripted, after a relaunch with a debugging port.
3. Command-line flags only take effect when no browser process is running on that data directory; otherwise the launch just opens a window in the running browser. Opening a URL that way (`google-chrome --profile-directory=<folder> <url>`) is fine and is how you open pages for me.
4. Chrome derives an unpacked extension's ID from its folder path. Keeping the same folder keeps the same ID and the same settings when Lector is updated later.
5. `Extensions.uninstall` deletes the extension's stored settings, `chrome.runtime.reload()` unloads an unpacked extension, and `Extensions.loadUnpacked` on top of my real install replaces it with a session-only one. Use none of them.
6. Chrome writes extension entries to the profile's `Preferences` file (on Linux, `extensions.settings.<id>.path`; not `Secure Preferences`), sometimes only when it next exits cleanly. The `Local State` file's `profile.info_cache` maps profile folders (`Default`, `Profile 1`) to the names I see.
7. On some Linux systems the `google-chrome` launcher adds flags from `~/.config/chrome-flags.conf`, so a process's command line can show flags you did not pass. To find a running browser, list processes whose executable is the browser binary itself (`/opt/google/chrome/chrome`, `.../Google Chrome.app/Contents/MacOS/Google Chrome`, `chrome.exe`) and keep only the one without a `--type=` argument; that is the main process. Crash handlers (`chrome_crashpad_handler`) and your own shell also match a loose `pgrep -f` or `pkill -f`, and `pkill -f <dir>` can kill your own shell, so never signal by pattern. On Linux, for example: `ps -eo pid=,args= | awk '$2 ~ /\/chrome$/ && !/--type=/'`, then signal that one PID.
</context>

<task>
Get Lector installed for good in the browser profile I choose, with my Gemini key saved and Narrated mode on, check that it works without playing any sound, and change nothing else in my browser.
</task>

<requirements>
1. Detect the setup. Find the operating system, which Chromium-based browsers are installed (Chrome, Edge, Brave, Chromium), which are running and with what `--user-data-dir` and `--profile-directory`, and the profiles in each data directory (fact 6). Show me the browsers and profile names and ask which one to install into. Check whether Lector is already installed there: read (do not edit) that profile's `Preferences` and look for an entry under `extensions.settings` whose `path` ends in `lector`. If the profile has no `Preferences` file or no such entry, treat Lector as not installed. Run `node --version` too; the helper script needs Node 22 or newer.

2. Download and unzip to a folder that stays put, because Chrome runs Lector from it:
   - Linux / macOS: `curl -fsSL -o "${TMPDIR:-/tmp}/lector.zip" https://github.com/Shinzuu/lector/releases/latest/download/lector.zip && unzip -qo "${TMPDIR:-/tmp}/lector.zip" -d "$HOME"`, giving `~/lector`.
   - Windows (PowerShell): `Invoke-WebRequest https://github.com/Shinzuu/lector/releases/latest/download/lector.zip -OutFile $env:TEMP\lector.zip; Expand-Archive $env:TEMP\lector.zip -DestinationPath $env:USERPROFILE -Force`, giving `%USERPROFILE%\lector`.
   Confirm `manifest.json` is directly inside that folder and use its absolute path from here on. If the folder already exists it is an earlier Lector: overwrite it in place, keeping the same path. If Lector was already installed from that folder, skip step 3 and ask me to click the reload arrow on Lector's card in chrome://extensions so the new files load.

3. Install (the one step that always needs me, fact 1):
   a. Copy the lector folder's absolute path to the clipboard (`wl-copy`, `xclip -selection clipboard`, `pbcopy`, or PowerShell `Set-Clipboard`) and also show it to me.
   b. Open the extensions page in the chosen profile by running the browser binary with `--profile-directory=<folder> chrome://extensions` (Edge: `edge://extensions`). If no tab opens, ask me to type `chrome://extensions` in the address bar.
   c. Tell me exactly what to do: switch on Developer mode (top right; bottom left in Edge), click Load unpacked, paste the path into the folder picker (Linux: Ctrl+L, then paste; macOS: Cmd+Shift+G, then paste; Windows: paste into the address bar at the top of the picker), press Enter, and click Select. Ask me to pin Lector from the puzzle-piece menu. Then wait until I say it is done.
   d. Ask me to read you the ID shown on Lector's card (32 letters a to p). Confirm it later from `Preferences` (fact 6) if the entry is there; if not, my confirmation is enough.

4. Get the Gemini key:
   a. Open https://aistudio.google.com/apikey in the chosen, signed-in profile: with your browser tool if it can drive that profile, otherwise by running the browser binary with that URL (fact 3).
   b. If the page asks me to sign in, stop and ask me to sign in, then wait. If Google shows terms to accept, ask me to accept them; do not accept on my behalf.
   c. Click "Create API key" (accept the suggested project, or create one), or ask me to click it if your tool cannot reach my profile. Then click the copy icon next to the new key, or ask me to. If I already have a key, I can copy it myself and you skip creating one.
   d. Keep the key out of the conversation. Do not read it from the page into your context, take screenshots or page snapshots while it is visible, or print, echo, log or save it to any file. It goes from the clipboard straight into Lector: by my paste (step 5) or by the helper script's standard input (step 6).

5. Save the settings, everyday profile (default data directory):
   a. Open Lector's options page in that profile: run the browser binary with `--profile-directory=<folder> chrome-extension://<id>/src/options.html`, or ask me to right-click the Lector icon and choose Options.
   b. Ask me to paste the key into "Gemini API key", check that "Narrated" is selected, and click Save. Saving writes `provider`, `geminiKey` and `mode` to `chrome.storage.local`. I should see "Saved." next to the button.
   c. Check it: open https://example.com in that profile and ask me to mute my computer's sound first (muting the tab is not enough, because Lector plays its voice from a hidden extension page), then press Alt+Shift+R. I confirm the reader bar appears at the bottom of the page and close it with Esc.

6. Save the settings, custom profile (non-default data directory), only if I agree to a restart:
   a. If that browser is running on that data directory, tell me it has to restart with a debugging port, that tabs come back only if "Continue where you left off" is on, and wait for my yes. If I say no, use step 5 instead. Quit it gracefully (macOS `osascript -e 'quit app "Google Chrome"'`; Windows `taskkill /IM chrome.exe` without `/F`; Linux `kill -TERM <pid>` on the main browser process found as in fact 7) and wait until that PID has exited.
   b. Relaunch it on the same profile with `--user-data-dir=<dir> --profile-directory=<folder> --remote-debugging-port=9333`, detached from your shell, and wait until `http://127.0.0.1:9333/json/version` answers. Do not add `--enable-unsafe-extension-debugging`; nothing here needs it.
   c. Save the helper script below to a temporary folder (not inside the lector folder) and run it with the key piped from the clipboard, so the key never appears in a command line or in your output: `wl-paste -n | node lector-check.mjs 9333` (X11 `xclip -selection clipboard -o`, macOS `pbpaste`, Windows `powershell -command Get-Clipboard |`). It finds the installed Lector, writes `provider`, `mode` and `geminiKey` from Lector's own options page, checks the key against Gemini's model list, and opens the reader bar on a local test page with speech blocked. Exit code 0 means everything passed; 1 means the settings or the reader bar check failed; 3 means Lector is not installed and enabled in this profile (go back to step 3); 4 means the bar works but the key is missing, malformed or rejected by Gemini (ask me to copy the key again and rerun).
   d. The debugging port stays open until this browser quits. Tell me, and offer to restart it normally (asking first, as in 6a) to close the port.

7. Once the key is saved and checked, offer to clear the clipboard (`wl-copy --clear`, `xclip -selection clipboard < /dev/null`, `pbcopy < /dev/null`, `Set-Clipboard -Value $null`).

8. Keep the sound off throughout. Never start Lector reading aloud yourself and never press Test voice in Options: I may be listening to something, and setup should be silent. The helper script blocks speech in its check, and in step 5c I press the key with my sound muted.
</requirements>

<decisions>
Already decided:
- Install folder: `~/lector` (Windows `%USERPROFILE%\lector`), kept permanently.
- Settings: provider "gemini", mode "narrated", my key. Nothing else.
- The install itself is my Load unpacked click (fact 1). Step 6 is only for a custom data directory and only with my yes; otherwise step 5.

Your call:
- If Node 22+ is missing, port the helper script to the CDP client you have (Python `websockets`, or Playwright's `connect_over_cdp`) with the same steps, or fall back to step 5.
- The debugging port number, if 9333 is taken.

Ask me before:
- closing or restarting any browser window;
- choosing a profile, if there is more than one;
- anything not described here.

Leave everything else alone. Add Lector and its three settings and change nothing else in my browser or profile: do not disable, uninstall, reload or reconfigure other extensions, do not change browser settings or flags beyond the one relaunch in step 6, do not create new profiles or data directories, do not edit `Preferences`, `Secure Preferences` or `Local State` (you only read them), do not copy or move profiles, and do not read cookies, passwords, history or other sites' data. If a step fails, stop and tell me instead of working around it inside my profile.
</decisions>

<helper_script>
Save as `lector-check.mjs` (step 6 only). It reads the key from standard input and prints only its length and whether it looks like a Gemini key.

```js
// lector-check.mjs: for a Chrome started with --remote-debugging-port on a custom --user-data-dir.
// Finds the installed Lector, saves its settings, and opens the reader bar once with speech blocked.
//   <key on stdin> | node lector-check.mjs <port>
// Empty stdin keeps the current key. The key itself is never printed.
import { createServer } from "node:http";
const port = process.argv[2] || "9333";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let key = "";
if (!process.stdin.isTTY) for await (const c of process.stdin) key += c;
key = key.trim();

const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let n = 0; const wait = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); wait.get(m.id)?.(m); };
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("cannot connect")); });
const send = (method, params = {}, sessionId) => new Promise((r) => { const id = ++n; wait.set(id, r);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const opened = [];
async function open(url) {
  const { result: { targetId } } = await send("Target.createTarget", { url, background: true });
  opened.push(targetId);
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  return async (expression) => {
    for (let i = 0; ; i++) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (!r.result?.exceptionDetails) return r.result?.result?.value;
      if (i === 19) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed");
      await sleep(300);
    }
  };
}
async function finish(code) {
  for (const targetId of opened) await send("Target.closeTarget", { targetId });
  ws.close(); process.exit(code);
}

// 1. Find Lector among the installed extensions (read only).
const ext = await open("chrome://extensions");
const found = await ext(`new Promise((r) => chrome.developerPrivate.getExtensionsInfo((l) =>
  r(l.filter((x) => x.name === "Lector").map((x) => ({ id: x.id, state: x.state, location: x.location })))))`);
console.log("installed: " + JSON.stringify(found));
const lector = found?.find((x) => x.state === "ENABLED");
if (!lector) { console.log("Lector is not installed and enabled in this profile."); await finish(3); }

// 2. Save the settings from Lector's options page, then read them back without the key.
const opt = await open(`chrome-extension://${lector.id}/src/options.html`);
const settings = { provider: "gemini", mode: "narrated", ...(key ? { geminiKey: key } : {}) };
await opt(`chrome.storage.local.set(${JSON.stringify(settings)}).then(() => 1)`);
const saved = await opt(`(async () => {
  const s = await chrome.storage.local.get(["provider", "mode", "geminiKey"]);
  const k = s.geminiKey || "";
  const accepted = k ? (await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": k } })).ok : null;
  return { provider: s.provider, mode: s.mode, keyLength: k.length, looksLikeGeminiKey: /^AIza[\\w-]{35}$/.test(k), acceptedByGemini: accepted };
})()`);
console.log("settings: " + JSON.stringify(saved));

// 3. Serve a test page on localhost, block speech in Lector's own world, open the bar, read it, close it.
const html = "<!doctype html><title>Lector test</title><h1>Lector test</h1><p>This page checks that the reader bar opens. It has two sentences.</p>";
const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(html)).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const testUrl = `http://127.0.0.1:${server.address().port}/`;
await open(testUrl);
await sleep(1500);
const bar = await opt(`(async () => {
  const audioBefore = await chrome.offscreen.hasDocument();
  const [t] = await chrome.tabs.query({ url: ${JSON.stringify(testUrl + "*")} });
  const inTab = (o) => chrome.scripting.executeScript({ target: { tabId: t.id }, ...o });
  await inTab({ func: () => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m, ...a) => (m && m.type === "tts" ? Promise.resolve({ ok: true }) : send(m, ...a));
    speechSynthesis.speak = () => {};
  } });
  await inTab({ files: ["src/reader.js"] });
  await inTab({ func: () => window.__lector.command("toggle") });
  await new Promise((r) => setTimeout(r, 1500));
  const [{ result }] = await inTab({ func: () => {
    const u = window.__lector._ui, st = window.__lector._state;
    const out = { barShown: !!u.host?.isConnected, mode: st.mode, status: u.status?.textContent || "" };
    window.__lector.command("toggle");
    return out;
  } });
  return { ...result, audioStarted: !audioBefore && (await chrome.offscreen.hasDocument()) };
})()`);
console.log("reader bar: " + JSON.stringify(bar));
server.close();
if (!(bar?.barShown && !bar.audioStarted && saved.provider === "gemini" && saved.mode === "narrated")) await finish(1);
await finish(saved.looksLikeGeminiKey && saved.acceptedByGemini !== false ? 0 : 4);
```
</helper_script>

<verification>
Before you report, confirm each of these and say how you know:
- Lector is installed in the chosen profile from the lector folder: my confirmation and its ID, plus the `Preferences` entry or the script's `installed:` line when available.
- The settings are saved: provider "gemini", mode "narrated", and a 39-character key starting with `AIza`. In step 5 that is the "Saved." message I saw; in step 6 it is `keyLength` 39, `looksLikeGeminiKey` true, and `acceptedByGemini` true when the network allows.
- The reader bar opened on a test page and no sound played: `barShown` true and `audioStarted` false (step 6), or my confirmation with sound muted (step 5).
- Every tab, window or process you opened for setup is closed, apart from my own browser.
- The key appears nowhere in your messages, commands or files.
</verification>

<output>
Finish with a short report:
- the browser, profile and steps used, and the lector folder path;
- each check above and its result;
- anything you could not do and what I should do about it;
- the three keys to remember: Alt+Shift+R starts or stops reading on any page; A pauses so I can ask a question out loud (say "continue" to go on); S opens the sections list to skip or jump. Also mention that PDF links open in Lector's own viewer, that I should keep the lector folder (Chrome runs Lector from it), and that for PDFs on my computer I can turn on "Allow access to file URLs" in Lector's Details on chrome://extensions.
</output>
