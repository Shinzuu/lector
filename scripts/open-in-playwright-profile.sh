#!/usr/bin/env bash
# Open Chrome on a Playwright profile with Lector loaded (branded Chrome ignores --load-extension, so
# Lector is loaded over the DevTools protocol). Its settings and key live in that profile and survive.
#   scripts/open-in-playwright-profile.sh [profile]      default: thesis
# The debugging port is open while this window runs; close the window when you're done.
set -euo pipefail
profile="${1:-thesis}"
dir="$HOME/.local/share/playwright/profiles/$profile"
ext="$(cd "$(dirname "$0")/.." && pwd)"
port=9399
setsid google-chrome-stable --user-data-dir="$dir" --remote-debugging-port=$port --enable-unsafe-extension-debugging \
  --no-first-run >/dev/null 2>&1 &
for _ in $(seq 50); do curl -s "http://127.0.0.1:$port/json/version" >/dev/null && break; sleep 0.2; done
node --input-type=module -e "
const v = await (await fetch('http://127.0.0.1:$port/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl); let id = 0; const P = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); P.get(m.id)?.(m); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; P.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const r = await send('Extensions.loadUnpacked', { path: '$ext' });
console.log(r.result ? 'Lector loaded (' + r.result.id + ')' : 'Lector failed: ' + JSON.stringify(r.error));
ws.close();
"
