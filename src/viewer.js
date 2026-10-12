// Lector's PDF viewer. Chrome's built-in PDF viewer cannot run extension scripts, so PDFs open here:
// pdf.js renders each page to a canvas plus a selectable text layer, and reader.js reads the text layer.
import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const pagesEl = document.getElementById("pages");
const nameEl = document.getElementById("name");
const readBtn = document.getElementById("read");
const drop = document.getElementById("drop");

chrome.tabs.getCurrent((t) => { if (t) window.__lector.tabId = t.id; });
window.__lector.setRoot(pagesEl, { pdf: true });
readBtn.onclick = () => window.__lector.command("toggle");

async function load(source, name) {
  nameEl.textContent = name;
  document.title = name + " · Lector";
  pagesEl.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Loading…" }));
  let pdf;
  try {
    pdf = await pdfjs.getDocument(source).promise;
  } catch (e) {
    pagesEl.replaceChildren(Object.assign(document.createElement("p"), {
      className: "error",
      textContent: "Could not open this PDF: " + e.message +
        (String(source.url || "").startsWith("file:") ? " Turn on “Allow access to file URLs” for Lector, or use Open PDF." : ""),
    }));
    return;
  }
  pagesEl.replaceChildren();
  const width = Math.min(pagesEl.clientWidth - 32, 1000);
  const lazy = new IntersectionObserver(onVisible, { rootMargin: "800px" });
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const div = document.createElement("div");
    div.className = "page";
    div.style.width = viewport.width + "px";
    div.style.height = viewport.height + "px";
    div.style.setProperty("--scale-factor", scale);
    const text = document.createElement("div");
    text.className = "textLayer";
    div.append(text);
    pagesEl.append(div);
    // Text layers are cheap and the reader needs all of them; canvases are drawn only near the viewport.
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
    div._page = page;
    div._viewport = viewport;
    lazy.observe(div);
  }
  readBtn.disabled = false;
}

function onVisible(entries, obs) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const div = e.target;
    obs.unobserve(div);
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(div._viewport.width * ratio);
    canvas.height = Math.floor(div._viewport.height * ratio);
    div.prepend(canvas);
    div._page.render({ canvasContext: canvas.getContext("2d"), viewport: div._viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
  }
}

const openFile = async (file) => file && load({ data: new Uint8Array(await file.arrayBuffer()) }, file.name);
document.getElementById("file").onchange = (e) => openFile(e.target.files[0]);
addEventListener("dragover", (e) => { e.preventDefault(); drop?.classList.add("over"); });
addEventListener("dragleave", () => drop?.classList.remove("over"));
addEventListener("drop", (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });

const url = new URLSearchParams(location.search).get("file");
if (url) load({ url }, decodeURIComponent(url.split("/").pop().split("?")[0]));
