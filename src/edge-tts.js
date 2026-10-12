// Microsoft Edge "Read Aloud" neural voices, called the way Edge itself calls them (protocol from the
// open-source edge-tts project, v7.2.8). This is an unofficial use of a public endpoint: it needs
// internet and may break if Microsoft changes it, in which case Lector falls back to Chrome's voices.

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "143.0.3650.75";
const HOST = "speech.platform.bing.com";
const WSS = `wss://${HOST}/consumer/speech/synthesize/readaloud/edge/v1`;

export const EDGE_VOICES = [
  ["en-US-AvaMultilingualNeural", "Ava (US, warm)"],
  ["en-US-AndrewMultilingualNeural", "Andrew (US, calm)"],
  ["en-US-EmmaMultilingualNeural", "Emma (US, bright)"],
  ["en-US-BrianMultilingualNeural", "Brian (US, relaxed)"],
  ["en-US-AriaNeural", "Aria (US, clear)"],
  ["en-US-JennyNeural", "Jenny (US, friendly)"],
  ["en-US-GuyNeural", "Guy (US, newsreader)"],
  ["en-GB-SoniaNeural", "Sonia (UK)"],
  ["en-GB-RyanNeural", "Ryan (UK)"],
  ["en-AU-NatashaNeural", "Natasha (Australia)"],
  ["en-IN-NeerjaNeural", "Neerja (India)"],
  ["en-IN-PrabhatNeural", "Prabhat (India)"],
];

// Edge's service only accepts its own extension's origin, so rewrite the handshake headers for our socket.
export async function installHeaderRule() {
  const muid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const major = EDGE_VERSION.split(".")[0];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      condition: { urlFilter: `|${WSS}`, resourceTypes: ["websocket"], initiatorDomains: [chrome.runtime.id] }, // only Lector's own sockets
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Origin", operation: "set", value: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold" },
          { header: "User-Agent", operation: "set", value: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0` },
          { header: "Cookie", operation: "set", value: `muid=${muid};` },
        ],
      },
    }],
  });
}

async function secMsGec() {
  let t = Date.now() / 1000 + 11644473600; // Windows file-time epoch
  t -= t % 300;
  const data = new TextEncoder().encode(`${(t * 1e7).toFixed(0)}${TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Returns the MP3 bytes for one piece of text.
export async function synthesize(text, voice, rate = 1) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const url = `${WSS}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=1-${EDGE_VERSION}&ConnectionId=${id}`;
  const pct = Math.round((rate - 1) * 100);
  const date = new Date().toString();
  const lang = voice.slice(0, 5);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const chunks = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error("Edge voice timed out")); }, 15000);
    ws.onopen = () => {
      ws.send(`X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      ws.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${pct >= 0 ? "+" : ""}${pct}%' volume='+0%'>${esc(text)}</prosody></voice></speak>`);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        if (e.data.includes("Path:turn.end")) {
          clearTimeout(timer);
          ws.close();
          const total = chunks.reduce((n, c) => n + c.length, 0);
          if (!total) return reject(new Error("Edge voice returned no audio"));
          const out = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { out.set(c, o); o += c.length; }
          resolve(out);
        }
        return;
      }
      const head = new DataView(e.data).getUint16(0);
      const header = new TextDecoder().decode(new Uint8Array(e.data, 2, head));
      if (header.includes("Path:audio")) chunks.push(new Uint8Array(e.data, 2 + head));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Edge voice connection failed")); };
    ws.onclose = (e) => { if (e.code !== 1000) { clearTimeout(timer); reject(new Error(`Edge voice closed (${e.code})`)); } };
  });
}
