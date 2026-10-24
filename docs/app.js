// Talk to your PDF: browser side.
// Entry (voice or text) → one conversation. It starts in the centre under the "L's" logo:
// say hi, ask how it works, or name a PDF. Once a PDF is chosen (tapped, or named in the
// chat) the conversation moves right and the PDF opens on the left. Answers lead with the
// page they came from; tapping it turns the PDF to that page. The particle logo
// (scene3d.js) beats while you talk and while answers are read aloud.

const TARGET_RATE = 16000;
const SAMPLE_QUESTIONS = ["How long is the warranty?", "What does error E07 mean?", "Who can install it?", "Blinking red light?"];
const GENERIC_QUESTIONS = ["What is this about?", "Summarise the key points", "Any important dates?"];
const START_SUGGESTIONS = ["Hi! What can you do?", "How does this work?"];

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const state = { docs: [], doc: null, recording: null, busy: false };

// ---------------------------------------------------------------- the 3D scene

const scene = window.DreamScene ? new DreamScene($("scene")) : null;
const sceneMode = (mode) => scene?.setMode(mode);

// ---------------------------------------------------------------- music & sounds (sound.js)

const ambient = window.Ambient ? new Ambient() : null;
// the logo beats softly with the music's bells and pulse, but only while it is resting
if (ambient) ambient.onBeat = (k) => { if (scene && scene.mode === "idle") scene.beat(k); };

// music pauses while the visitor is on another tab, and comes back when they return
document.addEventListener("visibilitychange", () => ambient?.setAway(document.hidden));
if (ambient) ambient.away = document.hidden;

function soundPref() {
  try { return localStorage.getItem("pdfa-sound") !== "0"; } catch { return true; }  // on by default
}

// on = the user's choice. Browsers need a click/keypress before audio can start, so if
// there hasn't been one yet the music starts on the next click anywhere.
function setSound(on, save = true) {
  $("sound-btn").setAttribute("aria-pressed", String(on));
  $("sound-btn").setAttribute("aria-label", on ? "Turn music and sounds off" : "Turn music and sounds on");
  $("set-sound").checked = on;
  if (save) { try { localStorage.setItem("pdfa-sound", on ? "1" : "0"); } catch {} }
  if (!ambient) return;
  if (!on) return ambient.setEnabled(false);
  if (navigator.userActivation?.hasBeenActive ?? true) ambient.setEnabled(true);
  else addEventListener("pointerdown", () => soundPref() && ambient.setEnabled(true), { once: true });
}
const sceneLevel = (v) => scene?.setLevel(v);

// "with-pdf": a PDF is open, so the conversation sits on the right and the PDF on the left
// (wide screens). Phones keep the conversation full width; the PDF slides over on demand.
const wide = () => innerWidth >= 900;
const withPdf = () => document.body.classList.contains("with-pdf");

// The logo sits in the empty slot at the top of the conversation: big while the
// conversation is fresh, small once it has started.
function placeScene() {
  if (!scene) return;
  const chat = $("workspace"), slot = $("logo-slot");
  const fresh = chat.classList.contains("fresh");
  const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));
  const phone = innerWidth <= 560;
  const slotH = fresh ? (phone ? clamp(120, innerHeight * 0.24, 200) : clamp(170, innerHeight * 0.34, 340)) : phone ? 64 : 84;
  const top = chat.getBoundingClientRect().top + slot.offsetTop;
  // where the column will END UP (it may be mid-slide): centred, or on the right.
  // Same sizes as .chat / --chat-w / --gutter in style.css.
  const gutter = clamp(16, innerWidth * 0.026, 36);
  const cx = withPdf() && wide() ? innerWidth - gutter - clamp(440, innerWidth * 0.42, 640) / 2 : innerWidth / 2;
  scene.place(cx / innerWidth, (top + slotH / 2) / innerHeight, (1.25 * slotH) / innerHeight);
}
addEventListener("resize", () => { placeScene(); setPlaceholder(); });

function setPlaceholder() {
  $("question").placeholder = innerWidth < 560 ? "Message…" : state.doc ? "Ask anything about this PDF…" : "Say hi, name a PDF, or ask a question…";
}

// ---------------------------------------------------------------- API

// Browser edition (GitHub Pages): there's no server; web/local/backend.js answers the same
// "/api/..." requests inside the page, with everything stored on this device.
const LOCAL = !!window.LOCAL_MODE;

async function api(path, options = {}) {
  if (LOCAL) return (await window.localBackendReady).request(path, options);
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`);
  }
  return res.json();
}

// ---------------------------------------------------------------- entry: voice or text

function setVoice(on) {
  $("speak").checked = on;
  $("set-voice").checked = on;
  $("speak-btn").setAttribute("aria-pressed", String(on));
  $("speak-btn").setAttribute("aria-label", on ? "Stop reading answers aloud" : "Read answers aloud");
  $("speak-btn").querySelector("use").setAttribute("href", on ? "#i-volume" : "#i-mute");
  try { localStorage.setItem("pdfa-voice", on ? "1" : "0"); } catch {}
}

// Page 1 (the welcome screen) lives at "/", the app at "/#app", so the browser's Back
// button and the "talk to your pdf" wordmark both lead back to page 1.
// One way in: typing and the mic both work from the chat, and "read answers aloud" keeps
// its saved setting (the speaker button next to the ask bar, or Settings).
function enter() {
  if (LOCAL) window.localBackendReady.then((b) => b.warmUp());
  setSound(soundPref(), false);            // this click lets the music start
  ambient?.whoosh(true);
  // The click is a user gesture, so the browser will allow speech later on.
  if ("speechSynthesis" in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(""), { volume: 0 }));
  if (location.hash !== "#app") { history.pushState({ app: true }, "", "#app"); state.pushedApp = true; }
  const entry = $("entry");
  entry.classList.add("leaving");          // circular bloom reveals the scene
  scene?.burst();
  setTimeout(() => { entry.hidden = true; entry.classList.remove("leaving"); document.body.classList.add("entered"); }, reduced() ? 0 : 1300);
  setTimeout(() => $("question").focus(), 1350);
}

function showEntry() {
  if (state.recording) stopRecording();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  closeLibrary();
  const entry = $("entry");
  entry.hidden = false;
  entry.classList.remove("leaving");
  document.body.classList.remove("entered");
  $("enter-btn").focus();
}

function setupEntry() {
  let voice = false;
  try { voice = localStorage.getItem("pdfa-voice") === "1"; } catch {}
  setVoice(voice);
  splitLetters();
  setSound(soundPref(), false);
  // Coming back from sign-in, or reloading inside the app: skip page 1.
  const skip = location.hash === "#app" || new URLSearchParams(location.search).has("signin");
  if (skip) {
    if (location.hash !== "#app") history.replaceState({ app: true }, "", location.pathname + "#app");
    $("entry").hidden = true;
    document.body.classList.add("entered");
  } else {
    $("enter-btn").focus();
  }
}

// Wrap each letter of the title in a span so the letters can rise one after another.
function splitLetters() {
  let i = 0;
  for (const el of document.querySelectorAll(".split")) {
    const text = el.textContent;
    el.textContent = "";
    for (const ch of text) {
      const span = document.createElement("span");
      span.className = "ch";
      span.textContent = ch === " " ? "\u00a0" : ch;
      span.style.setProperty("--i", i++);
      span.setAttribute("aria-hidden", "true");
      el.append(span);
    }
  }
}

addEventListener("popstate", () => { if (location.hash !== "#app") showEntry(); else if (!$("entry").hidden) enter(); });

// ---------------------------------------------------------------- documents

const docTitle = (d) => d.filename.replace(/\.pdf$/i, "");

// The picker under "Let's talk.": the most recent PDFs as chips, plus "all" and "upload".
function renderPicks() {
  const box = $("doc-picks");
  box.innerHTML = "";
  const recent = [...state.docs].reverse().slice(0, 5);
  for (const d of recent) box.append(docButton(d, "pick"));
  if (state.docs.length > recent.length) {
    const all = document.createElement("button");
    all.type = "button";
    all.className = "pick more";
    all.dataset.library = "";
    all.innerHTML = `${icon("library")}All ${state.docs.length} PDFs`;
    box.append(all);
  }
  const up = document.createElement("button");
  up.type = "button";
  up.className = "pick add";
  up.dataset.upload = "";
  up.innerHTML = `${icon("plus")}${state.docs.length ? "Add PDFs" : "Upload PDFs"}`;
  box.append(up);
  if (!state.docs.length) {
    const sample = document.createElement("button");
    sample.type = "button";
    sample.className = "pick ghost";
    sample.dataset.sample = "";
    sample.innerHTML = `${icon("sparkle")}Try the sample manual`;
    box.append(sample);
  }
}

// A PDF as a small button (in the picker, or as a choice under a reply).
function docButton(d, cls, pending = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.dataset.choose = d.doc_id;
  if (pending) b.dataset.pending = pending;
  b.title = d.filename;
  b.innerHTML = `${icon("doc")}<span></span>`;
  b.querySelector("span").textContent = docTitle(d);
  return b;
}

// Small suggestion pills above the ask bar, side by side.
function renderSuggestions() {
  const qs = state.doc ? (/sample/i.test(state.doc.filename) ? SAMPLE_QUESTIONS : GENERIC_QUESTIONS)
    : state.docs.length ? START_SUGGESTIONS : [...START_SUGGESTIONS, "Open the sample manual"];
  const asked = new Set([...$("messages").querySelectorAll(".msg.user")].map((m) => m.dataset.text));
  const box = $("suggest");
  box.innerHTML = "";
  for (const q of qs.filter((q) => !asked.has(q))) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.dataset.ask = q;
    box.append(b);
  }
  box.hidden = !box.children.length;
}

function setFresh(fresh) {
  $("workspace").classList.toggle("fresh", fresh);
  placeScene();
  setTimeout(placeScene, 500);   // again once the slot has finished resizing
}

function updateIntro() {
  $("intro-title").textContent = state.doc ? "Ask me anything." : "Let's talk.";
  $("intro-sub").textContent = state.doc
    ? `About ${docTitle(state.doc)}. Every answer shows its page.`
    : state.docs.length ? "Choose a PDF, or just tell me which one. Then ask me anything." : "Add a PDF to begin, then ask me anything about it, typed or out loud.";
  $("doc-picks").hidden = !!state.doc;
  renderPicks();
}

// ---------------------------------------------------------------- library: all your PDFs

function renderLibrary() {
  const n = state.docs.length;
  $("library-btn").hidden = n === 0;
  $("library-count").textContent = n;
  $("library-search-wrap").hidden = n < 6;
  const query = $("library-search").value.trim().toLowerCase();
  const list = $("library-list");
  list.innerHTML = "";
  const docs = [...state.docs].reverse().filter((d) => d.filename.toLowerCase().includes(query)); // newest first
  if (!docs.length) list.innerHTML = `<li class="library-empty">${n ? "No PDF matches that name." : "No PDFs yet. Add one to start."}</li>`;
  for (const d of docs) {
    const li = document.createElement("li");
    li.className = "library-item" + (d.doc_id === state.doc?.doc_id ? " current" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "library-open";
    open.dataset.open = d.doc_id;
    const when = d.uploaded_at ? new Date(d.uploaded_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
    open.innerHTML = `${icon("doc")}<span class="li-text"><span class="li-name"></span><span class="li-meta">${d.pages} page${d.pages === 1 ? "" : "s"}${when ? ` · ${when}` : ""}${d.doc_id === state.doc?.doc_id ? " · open now" : ""}</span></span>`;
    open.querySelector(".li-name").textContent = d.filename;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-delete";
    del.dataset.delete = d.doc_id;
    del.setAttribute("aria-label", `Delete ${d.filename}`);
    del.innerHTML = icon("trash");
    li.append(open, del);
    list.append(li);
  }
}

// "My PDFs" pops out of its button like the settings bubble.
function openLibrary() {
  closeHistory();
  renderLibrary();
  const lib = $("library"), btn = $("library-btn");
  lib.hidden = false;
  // grow from the button: point the animation's origin at it
  const b = btn.getBoundingClientRect(), l = lib.getBoundingClientRect();
  if (!btn.hidden && b.width) lib.style.transformOrigin = `${Math.round(b.left + b.width / 2 - l.left)}px -10px`;
  lib.classList.remove("closing");
  lib.classList.add("open", "popping");
  btn.setAttribute("aria-expanded", "true");
  ambient?.bubble();
  ($("library-search-wrap").hidden ? $("library-list").querySelector("button") : $("library-search"))?.focus();
}

function closeLibrary() {
  const lib = $("library");
  if (lib.hidden) return;
  lib.classList.remove("open", "popping");
  lib.classList.add("closing");
  $("library-btn").setAttribute("aria-expanded", "false");
  setTimeout(() => { if (lib.classList.contains("closing")) { lib.hidden = true; lib.classList.remove("closing"); } }, reduced() ? 0 : 300);
}

// A small line in the conversation, e.g. "Now talking about: Lease agreement".
function addDivider(text) {
  const li = document.createElement("li");
  li.className = "divider";
  li.textContent = text;
  $("messages").append(li);
}

// Choose a PDF: the conversation slides right and the PDF opens on the left.
function openDoc(info, { say = false } = {}) {
  if (state.doc?.doc_id === info.doc_id) return;
  closeHistory();
  const first = !state.doc;
  state.doc = info;
  if ($("messages").children.length) addDivider(`Now talking about ${docTitle(info)}`);
  if (say) addBotMessage({ kind: "chat", answer: `Opened ${docTitle(info)}. What would you like to know?`, spoken: "", citations: [], choices: [] });
  $("chat-doc").textContent = docTitle(info);
  $("chat-pages").textContent = `${info.pages} page${info.pages === 1 ? "" : "s"}`;
  $("doc-bar").hidden = false;
  if (first) ambient?.whoosh(true);
  scene?.burst();
  if (first) relocateChat("-60px");
  document.body.classList.add("with-pdf");
  showPdf(1, wide());
  closeLibrary();
  renderLibrary();
  updateIntro();
  renderSuggestions();
  setPlaceholder();
  placeScene();
  setTimeout(placeScene, 950);
  hideError();
  scrollChat();
}

// Close the PDF: the conversation glides back to the centre.
function closeDoc() {
  if (!state.doc) return;
  addDivider(`Closed ${docTitle(state.doc)}`);
  state.doc = null;
  document.body.classList.remove("with-pdf");
  relocateChat("60px");
  $("doc-bar").hidden = true;
  closePreview();
  ambient?.whoosh(false);
  renderLibrary();
  updateIntro();
  renderSuggestions();
  setPlaceholder();
  placeScene();
  setTimeout(placeScene, 950);
  $("question").focus();
}

// Show a panel, then add "open" so its CSS transition plays. Forcing a layout (instead of
// waiting for the next animation frame) also works when the tab is in the background.
function slideIn(el) {
  void el.offsetWidth;
  el.classList.add("open");
}

// The chat card changes size and place when a PDF opens or closes; instead of animating
// its width, it appears in the new place and glides in from the side it came from.
function relocateChat(from) {
  if (!wide() || reduced()) return;
  const c = $("workspace");
  c.style.setProperty("--from", from);
  c.classList.remove("arrive");
  void c.offsetWidth;
  c.classList.add("arrive");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- the PDF pane (PDF.js)
// Browsers' own PDF viewers can't be trusted inside a page: iPhone Safari shows only the
// first page and ignores "#page=", Android Chrome shows nothing at all. So we draw the
// pages ourselves with PDF.js: one canvas per page, drawn only when it scrolls near view.

const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const pdfView = { docId: null, pdf: null, loading: null, observer: null, width: 0 };
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;   // also used to read uploads (browser edition)

async function loadPdf(docId) {
  if (pdfView.docId === docId) return pdfView.loading;
  resetPdf();
  pdfView.docId = docId;
  const box = $("viewer");
  $("pdf-open").href = LOCAL ? "#" : `/api/documents/${docId}/file`;
  if (LOCAL) (await window.localBackendReady).fileUrl(docId).then((u) => { if (pdfView.docId === docId) $("pdf-open").href = u; }).catch(() => {});
  if (!window.pdfjsLib) {
    box.innerHTML = `<p class="pdf-msg">The page viewer couldn't load. Use “Open file” above.</p>`;
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  box.innerHTML = `<p class="pdf-msg">Opening…</p>`;
  pdfView.loading = (async () => {
    try {
      const source = LOCAL ? { data: await (await window.localBackendReady).fileData(docId) } : { url: `/api/documents/${docId}/file`, withCredentials: true };
      const pdf = await pdfjsLib.getDocument(source).promise;
      if (pdfView.docId !== docId) return pdf.destroy();
      pdfView.pdf = pdf;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      box.innerHTML = "";
      // empty page frames with the right shape, so scrolling to page N works before it's drawn
      for (let n = 1; n <= pdf.numPages; n++) {
        const frame = document.createElement("div");
        frame.className = "pdf-page";
        frame.dataset.n = n;
        frame.style.aspectRatio = `${first.width} / ${first.height}`;
        frame.setAttribute("aria-label", `Page ${n}`);
        box.append(frame);
      }
      pdfView.observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) drawPage(e.target);
      }, { root: box, rootMargin: "800px 0px" });
      box.querySelectorAll(".pdf-page").forEach((f) => pdfView.observer.observe(f));
    } catch {
      if (pdfView.docId === docId) box.innerHTML = `<p class="pdf-msg">This PDF couldn't be shown here. Use “Open file” above.</p>`;
    }
  })();
  return pdfView.loading;
}

async function drawPage(frame) {
  const width = frame.clientWidth;
  if (!pdfView.pdf || !width || frame.dataset.drawn === String(width)) return;
  frame.dataset.drawn = String(width);
  const page = await pdfView.pdf.getPage(Number(frame.dataset.n));
  const base = page.getViewport({ scale: 1 });
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (width / base.width) * ratio });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  frame.style.aspectRatio = `${base.width} / ${base.height}`;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  if (frame.dataset.drawn === String(width)) frame.replaceChildren(canvas);
}

function resetPdf() {
  pdfView.observer?.disconnect();
  pdfView.pdf?.destroy();
  Object.assign(pdfView, { docId: null, pdf: null, loading: null, observer: null });
  $("viewer").innerHTML = "";
}

async function scrollPdfTo(page) {
  await pdfView.loading;
  const box = $("viewer"), frame = box.querySelector(`.pdf-page[data-n="${page}"]`);
  if (frame) box.scrollTo({ top: frame.offsetTop - 12, behavior: reduced() ? "auto" : "smooth" });
}

// The page indicator follows scrolling.
$("viewer").addEventListener("scroll", () => {
  const box = $("viewer");
  const frames = box.querySelectorAll(".pdf-page");
  if (!frames.length || !state.doc) return;
  let current = 1;
  for (const f of frames) if (f.offsetTop - box.scrollTop <= box.clientHeight * 0.4) current = Number(f.dataset.n);
  $("page-ind").textContent = `page ${current} of ${frames.length}`;
}, { passive: true });

// Redraw sharper pages when the pane changes width.
let pdfResize;
addEventListener("resize", () => {
  clearTimeout(pdfResize);
  pdfResize = setTimeout(() => $("viewer").querySelectorAll(".pdf-page").forEach((f) => {
    const r = f.getBoundingClientRect(), box = $("viewer").getBoundingClientRect();
    if (r.bottom > box.top - 800 && r.top < box.bottom + 800) drawPage(f);
  }), 250);
});

// Show the PDF at a page. Wide screens: it's the left pane. Phones: it slides over the chat.
function showPdf(page, visible = true) {
  if (!state.doc) return;
  $("page-ind").textContent = `page ${page} of ${state.doc.pages}`;
  loadPdf(state.doc.doc_id);
  if (!visible) return closePreview();
  $("preview").hidden = false;
  slideIn($("preview"));
  scrollPdfTo(page);
}

// A page chip: open that answer's PDF (if another one is open now) at that page.
function jumpToPage(page, docId) {
  const doc = docId && state.docs.find((d) => d.doc_id === docId);
  if (docId && !doc) return toast("That PDF isn't in your library any more.", true);
  if (doc && doc.doc_id !== state.doc?.doc_id) openDoc(doc);
  showPdf(page);
}

function closePreview() {
  $("preview").classList.remove("open");
  setTimeout(() => { if (!$("preview").classList.contains("open")) $("preview").hidden = true; }, reduced() ? 0 : 450);
}

// Upload one or many PDFs, one after another, then open the first one that worked.
async function uploadMany(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const status = $("upload-status");
  status.className = "status";
  const failed = [];
  let first = null;
  sceneMode("thinking");
  for (const [i, file] of files.entries()) {
    status.textContent = files.length > 1 ? `Reading ${i + 1} of ${files.length}: ${file.name}…` : `Reading ${file.name}…`;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      failed.push(`${file.name}: not a PDF`);
      continue;
    }
    const form = new FormData();
    form.append("file", file);
    try {
      const info = await api("/api/documents", { method: "POST", body: form });
      first ??= info;
      scene?.beat(0.6);
    } catch (e) {
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  sceneMode("idle");
  $("file-input").value = "";
  await refreshDocs();
  renderLibrary();
  updateIntro();
  status.textContent = failed.length ? `Couldn't add ${failed.length}: ${failed.join(" · ")}` : "";
  status.classList.toggle("err", failed.length > 0);
  const added = files.length - failed.length;
  if (added > 1) toast(`${added} PDFs added. Pick one to talk about, or name it in the chat.`);
  if (added === 1 && first) openDoc(first, { say: true });
  else if (added > 1) scene?.burst();
}

async function refreshDocs() {
  state.docs = await api("/api/documents");
}

async function deleteDoc(docId) {
  const doc = state.docs.find((d) => d.doc_id === docId);
  if (!doc || !confirm(`Delete "${doc.filename}" from your library? This can't be undone.`)) return;
  try {
    await api(`/api/documents/${doc.doc_id}`, { method: "DELETE" });
  } catch (e) {
    return toast(e.message, true);
  }
  if (state.doc?.doc_id === doc.doc_id) {
    closeDoc();
    resetPdf();
  }
  await refreshDocs();
  renderLibrary();
  updateIntro();
}

// ---------------------------------------------------------------- identity: guest or signed-in account

// Official brand marks for the sign-in buttons.
const PROVIDER_LOGOS = {
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>`,
  microsoft: `<svg viewBox="0 0 23 23" aria-hidden="true"><path fill="#F35325" d="M1 1h10v10H1z"/><path fill="#81BC06" d="M12 1h10v10H12z"/><path fill="#05A6F0" d="M1 12h10v10H1z"/><path fill="#FFBA08" d="M12 12h10v10H12z"/></svg>`,
};

async function loadIdentity() {
  let me;
  try { me = await api("/api/me"); } catch { return; }
  const signedIn = me.kind === "account";
  $("pill-label").textContent = signedIn ? me.name || me.email || "Your account" : LOCAL ? "On this device" : "Guest";
  $("user-id").textContent = "";
  $("pill-lock").hidden = signedIn;
  $("avatar").hidden = !signedIn;
  $("avatar").textContent = (me.name || me.email || "?").trim()[0].toUpperCase();
  $("private-pill").title = signedIn
    ? `Signed in with ${me.provider === "google" ? "Google" : "Microsoft"}${me.email ? ` as ${me.email}` : ""}. Your PDFs are private to your account.`
    : LOCAL ? "Your PDFs stay on this device: they're read and searched right here in your browser. Nothing is uploaded."
    : "Guest: your PDFs are private to this browser. Nobody else can see or search them.";
  $("signout").hidden = !signedIn;
  $("signin").hidden = signedIn || me.providers.length === 0;
  $("signin-options").innerHTML = me.providers
    .map((p) => `<a class="provider-btn" href="/auth/${p.id}/login">${PROVIDER_LOGOS[p.id] || ""}Continue with ${p.label}</a>`)
    .join("");
}

function showSignInResult() {
  const params = new URLSearchParams(location.search);
  const result = params.get("signin");
  if (!result) return;
  history.replaceState(null, "", location.pathname); // tidy the address bar
  const moved = Number(params.get("moved") || 0);
  toast(
    result === "ok"
      ? `Signed in.${moved ? ` ${moved} PDF${moved > 1 ? "s" : ""} moved into your account.` : ""}`
      : "Sign-in didn't complete, so you're still a guest. Try again.",
    result !== "ok",
  );
}

function toast(message, isError = false) {
  const el = document.createElement("div");
  el.className = `toast${isError ? " err" : ""}`;
  el.setAttribute("role", isError ? "alert" : "status");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

async function signOut() {
  await api("/auth/logout", { method: "POST" });
  state.doc = null;
  location.reload();
}

// ---------------------------------------------------------------- chat

function addUserMessage(text, via) {
  const li = document.createElement("li");
  li.className = "msg user";
  li.dataset.text = text;
  li.textContent = text;
  if (via === "voice") li.insertAdjacentHTML("afterbegin", `<span class="via">${icon("mic")}</span>`);
  $("messages").append(li);
  setFresh(false);
  return li;
}

function addTyping() {
  const li = document.createElement("li");
  li.className = "typing";
  li.setAttribute("aria-label", "Thinking");
  li.innerHTML = "<i></i><i></i><i></i>";
  $("messages").append(li);
  scrollChat();
  return li;
}

// Answer text with [p. N] turned into small page buttons (built safely, no innerHTML).
function answerNodes(text, docId) {
  const frag = document.createDocumentFragment();
  text.split(/\[p\.\s*(\d+)\]/).forEach((part, i) => {
    if (i % 2 === 0) return frag.append(document.createTextNode(part));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cite";
    b.dataset.page = part;
    if (docId) b.dataset.doc = docId;
    b.textContent = `p.${part}`;
    b.setAttribute("aria-label", `Open page ${part}`);
    frag.append(b);
  });
  return frag;
}

function addBotMessage(ans, { restoring = false } = {}) {
  const li = document.createElement("li");
  li.className = `msg bot ${ans.kind === "chat" ? "talk" : ""}`;
  const top = ans.citations[0];
  if (ans.kind !== "chat" && !top) li.classList.add("not-found");

  if (top) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "page-chip";
    chip.dataset.page = top.page;
    chip.dataset.doc = ans.doc_id || "";
    chip.innerHTML = `${icon("doc")}Page ${top.page}`;
    chip.setAttribute("aria-label", `Open page ${top.page}`);
    li.append(chip);
  }
  if (ans.highlight) {
    const short = document.createElement("p");
    short.className = "short-answer";
    short.textContent = ans.highlight;
    li.append(short);
  }
  const body = document.createElement("p");
  body.className = "answer-text";
  // The page is already shown in the chip, so drop a trailing citation to keep it clean.
  body.append(answerNodes(top ? ans.answer.replace(/\s*\[p\.\s*\d+\]\s*$/, "") : ans.answer, ans.doc_id));
  li.append(body);
  if (ans.choices?.length) {
    const box = document.createElement("div");
    box.className = "choices";
    for (const d of ans.choices) box.append(docButton(d, "pick", ans.pending));
    li.append(box);
  }
  if (ans.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = ans.note;
    li.append(note);
  }
  if (ans.spoken && ans.kind !== "chat") {
    const play = document.createElement("button");
    play.type = "button";
    play.className = "play";
    play.dataset.spoken = ans.spoken;
    play.innerHTML = `${icon("volume")}Listen`;
    li.append(play);
  }

  $("messages").append(li);
  setFresh(false);
  scrollChat();
  if (restoring) return;
  if (top) scene?.burst();
  // the PDF pane turns to the page the answer came from
  if (top && wide() && withPdf() && (!ans.doc_id || ans.doc_id === state.doc?.doc_id)) showPdf(top.page);
  if ($("speak").checked && ans.spoken) speak(ans.spoken);
}

// Pick a PDF from a chip/choice. If the user had already asked something, answer it now.
function choose(docId, pending) {
  const doc = state.docs.find((d) => d.doc_id === docId);
  if (!doc) return;
  openDoc(doc, { say: !pending });
  if (pending) send(pending, "text", null, { echo: false });
}

// One listener for the conversation, the picker and the suggestions.
for (const id of ["messages", "doc-picks", "suggest"]) {
  $(id).addEventListener("click", (e) => {
    const page = e.target.closest("[data-page]");
    if (page) return jumpToPage(Number(page.dataset.page), page.dataset.doc);
    const play = e.target.closest(".play");
    if (play) return speak(play.dataset.spoken);
    const pick = e.target.closest("[data-choose]");
    if (pick) return choose(pick.dataset.choose, pick.dataset.pending);
    if (e.target.closest("[data-library]")) return openLibrary();
    if (e.target.closest("[data-upload]")) return $("file-input").click();
    if (e.target.closest("[data-sample]")) return addSample();
    const suggestion = e.target.closest("[data-ask]");
    if (suggestion) return suggestion.dataset.ask === "Open the sample manual" ? addSample() : send(suggestion.dataset.ask, "text");
  });
}

function scrollChat() {
  const box = $("panel-scroll");
  box.scrollTop = box.scrollHeight;
}

// Everything goes through /api/chat: small talk, help, "open X", or a question about a PDF.
async function send(message, via, audio, { echo = true } = {}) {
  if (state.busy) return;
  if (!audio && !message.trim()) return;
  hideError();
  setBusy(true);
  const userMsg = audio ? addUserMessage("…", via) : echo ? addUserMessage(message.trim(), via) : null;
  const typing = addTyping();
  try {
    const params = new URLSearchParams();
    if (state.doc) params.set("doc_id", state.doc.doc_id);
    if (state.conv) params.set("conv_id", state.conv);
    const docQuery = params.toString() ? `?${params}` : "";
    const ans = audio
      ? await api(`/api/chat/voice${docQuery}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: audio.buffer })
      : await api("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: message.trim(), doc_id: state.doc?.doc_id ?? null, conv_id: state.conv, via }) });
    if (audio) {
      userMsg.textContent = ans.question;
      userMsg.dataset.text = ans.question;
      userMsg.insertAdjacentHTML("afterbegin", `<span class="via">${icon("mic")}</span>`);
    }
    typing.remove();
    if (ans.conv_id) setConv(ans.conv_id);   // saved: the first message starts a new saved chat
    if (ans.open_doc) openDoc(state.docs.find((d) => d.doc_id === ans.open_doc.doc_id) || ans.open_doc);
    addBotMessage(ans);
    renderSuggestions();
  } catch (e) {
    typing.remove();
    if (audio) userMsg.remove();
    showError(e.message);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- saved chats (sidebar)
// Like ChatGPT: "+ New chat" (or a page refresh) starts fresh, and every earlier chat is
// saved (private to you) and listed in the sidebar, where any of them can be reopened.

function setConv(id) {
  state.conv = id || null;
  try { id ? localStorage.setItem("pdfa-conv", id) : localStorage.removeItem("pdfa-conv"); } catch {}
}

function showMessages(rows) {
  $("messages").innerHTML = "";
  for (const row of rows) {
    addUserMessage(row.message, row.via);
    addBotMessage(row.reply, { restoring: true });
  }
  setFresh(!rows.length);
  renderSuggestions();
  scrollChat();
}

// "+ New chat": the current chat is already saved; start an empty one in the centre.
function newChat() {
  if (state.busy) return;
  closeHistory();
  if (state.doc) closeDoc();
  setConv(null);
  showMessages([]);
  hideError();
  ambient?.whoosh(false);
  $("question").focus();
}

async function openConversation(id) {
  if (state.busy) return;
  let rows;
  try { rows = await api(`/api/conversations/${encodeURIComponent(id)}`); } catch (e) { return toast(e.message, true); }
  closeHistory();
  if (state.doc) closeDoc();
  setConv(id);
  showMessages(rows);
}

function renderHistory() {
  const query = $("history-search").value.trim().toLowerCase();
  const list = $("history-list");
  list.innerHTML = "";
  const items = (state.convs || []).filter((c) => c.title.toLowerCase().includes(query));
  if (!items.length) list.innerHTML = `<li class="library-empty">${state.convs?.length ? "No chat matches that." : "No saved chats yet. Ask something and it's saved here."}</li>`;
  for (const c of items) {
    const li = document.createElement("li");
    li.className = "library-item" + (c.id === state.conv ? " current" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "library-open";
    open.dataset.conv = c.id;
    const when = new Date(c.updated_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    open.innerHTML = `${icon("history")}<span class="li-text"><span class="li-name"></span><span class="li-meta"></span></span>`;
    open.querySelector(".li-name").textContent = c.title;
    open.querySelector(".li-meta").textContent = `${when} · ${c.messages} message${c.messages === 1 ? "" : "s"}${c.id === state.conv ? " · open now" : ""}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "library-delete";
    del.dataset.delConv = c.id;
    del.setAttribute("aria-label", `Delete chat: ${c.title}`);
    del.innerHTML = icon("trash");
    li.append(open, del);
    list.append(li);
  }
}

async function openHistory() {
  closeLibrary();
  try { state.convs = await api("/api/conversations"); } catch { state.convs = []; }
  renderHistory();
  $("history").hidden = false;
  document.body.classList.add("sidebar-open");   // the PDF steps aside while the list is open
  slideIn($("history"));
  $("history-search").focus();
}

function closeHistory() {
  $("history").classList.remove("open");
  document.body.classList.remove("sidebar-open");
  setTimeout(() => { if (!$("history").classList.contains("open")) $("history").hidden = true; }, reduced() ? 0 : 400);
}

async function deleteConversation(id) {
  const c = state.convs?.find((x) => x.id === id);
  if (!c || !confirm(`Delete the chat "${c.title}"?`)) return;
  try { await api(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
  state.convs = state.convs.filter((x) => x.id !== id);
  if (state.conv === id) { setConv(null); showMessages([]); }
  renderHistory();
}

async function addSample() {
  $("upload-status").className = "status";
  $("upload-status").textContent = "Adding the sample manual…";
  try {
    const info = await api("/api/sample", { method: "POST" });
    await refreshDocs();
    $("upload-status").textContent = "";
    openDoc(info, { say: true });
  } catch (e) {
    $("upload-status").textContent = e.message;
    $("upload-status").classList.add("err");
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const el of document.querySelectorAll(".composer button, .suggest button, .pick")) el.disabled = busy;
  $("speak-btn").disabled = false;
  setMic(busy ? "thinking" : state.recording ? "listening" : "idle");
}

// ---------------------------------------------------------------- speech out

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("en") && v.localService);
  if (voice) u.voice = voice;
  // The browser can't report the voice's loudness, so pulse the particles on each word.
  // The browser can't tell us how loud the voice is, so the logo beats in a speech-like
  // rhythm (uneven syllables, 150–330 ms apart) and hits harder on each word it reports.
  let beatTimer = null, speaking = false;
  const syllable = () => {
    if (!speaking) return;
    scene?.beat(0.45 + Math.random() * 0.4);
    sceneLevel(0.25 + Math.random() * 0.3);
    beatTimer = setTimeout(syllable, 150 + Math.random() * 180);
  };
  u.onstart = () => {
    speaking = true;
    if (!state.recording) ambient?.duck(1);   // music steps back while the answer is read
    sceneMode("speaking");
    syllable();
  };
  u.onboundary = () => scene?.beat(1);
  u.onend = u.onerror = () => {
    speaking = false;
    if (!state.recording) ambient?.duck(0);
    clearTimeout(beatTimer);
    sceneLevel(0);
    if (!state.busy && !state.recording) sceneMode("idle");
  };
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- speech in

// Browser edition: no server to run Whisper, so use the browser's own speech recognition.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function startDictation() {
  if (!Recognition) return showError("Voice isn't supported in this browser. Try Chrome, Edge or Safari, or type your question.");
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  const rec = new Recognition();
  rec.lang = navigator.language?.startsWith("en") ? navigator.language : "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (const r of e.results) (r.isFinal ? (finalText = r[0].transcript) : (interim += r[0].transcript));
    $("question").value = finalText || interim;   // show the words as they're heard
    scene?.beat(0.7);
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") showError("Microphone access is blocked. Allow the microphone for this page in your browser settings, or type instead.");
    else if (e.error !== "no-speech" && e.error !== "aborted") showError("Voice didn't work this time. Try again, or type your question.");
  };
  rec.onend = () => {
    state.recording = null;
    ambient?.duck(0);
    setMic("idle");
    const text = (finalText || $("question").value).trim();
    $("question").value = "";
    if (text) send(text, "voice");
  };
  state.recording = { dictation: rec };
  ambient?.duck(2);
  setMic("listening");
  hideError();
  rec.start();
}

async function startRecording() {
  if (LOCAL) return state.recording ? null : startDictation();
  if (state.recording || state.busy) return;
  hideError();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    showError("Microphone access is blocked. Allow the microphone for this page in your browser settings, or type instead.");
    return;
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(analyser);
  source.connect(processor);
  processor.connect(ctx.destination);
  state.recording = { stream, ctx, processor, chunks, analyser };
  ambient?.duck(2);   // silence the music so it isn't recorded with the question
  setMic("listening");
  followVoice();
}

async function stopRecording() {
  const rec = state.recording;
  if (!rec) return;
  if (rec.dictation) return rec.dictation.stop();   // onend sends what was heard
  state.recording = null;
  ambient?.duck(0);
  rec.processor.disconnect();
  rec.stream.getTracks().forEach((t) => t.stop());
  const pcm = toPcm16(rec.chunks, rec.ctx.sampleRate);
  await rec.ctx.close();
  setMic("idle");
  if (pcm.length < TARGET_RATE / 4) {
    showError("That was too short to hear. Tap the mic, ask your question, then tap again.");
    return;
  }
  await send("", "voice", pcm);
}

// Merge recorded buffers, resample to 16 kHz, convert to 16-bit integers.
function toPcm16(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  const ratio = rate / TARGET_RATE;
  const out = new Int16Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, total - 1);
    const s = merged[i0] + (merged[i1] - merged[i0]) * (x - i0);
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  return out;
}

// Feed the microphone's loudness (RMS) to the particles while recording.
function followVoice() {
  const rec = state.recording;
  if (!rec) return sceneLevel(0);
  const data = new Uint8Array(rec.analyser.fftSize);
  rec.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += ((v - 128) / 128) ** 2;
  const level = Math.min(1, Math.sqrt(sum / data.length) * 5);
  sceneLevel(level);
  // Beat on each syllable: a sudden rise above the recent average ("onset").
  const now = performance.now();
  rec.avg = rec.avg === undefined ? level : rec.avg * 0.92 + level * 0.08;
  if (level > 0.12 && level > rec.avg * 1.5 && now - (rec.lastBeat || 0) > 140) {
    scene?.beat(Math.min(1, 0.4 + level));
    rec.lastBeat = now;
  }
  requestAnimationFrame(followVoice);
}

function setMic(mode) {
  const mic = $("mic");
  mic.classList.toggle("listening", mode === "listening");
  mic.classList.toggle("thinking", mode === "thinking");
  $("composer").classList.toggle("listening", mode === "listening");
  mic.setAttribute("aria-pressed", String(mode === "listening"));
  mic.setAttribute("aria-label", { idle: "Ask by voice", listening: "Stop and send", thinking: "Finding the answer" }[mode]);
  mic.disabled = mode === "thinking";
  mic.querySelector("use").setAttribute("href", { idle: "#i-mic", listening: "#i-square", thinking: "#i-loader" }[mode]);
  if (mode !== "idle" || !("speechSynthesis" in window) || !speechSynthesis.speaking) sceneMode(mode);
  $("mic-hint").textContent = {
    idle: "Tap the mic to talk, tap again to send.",
    listening: "Listening… tap again when you're done.",
    thinking: "Thinking…",
  }[mode];
}

function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }
function hideError() { $("error").hidden = true; }

// ---------------------------------------------------------------- wiring

$("enter-btn").addEventListener("click", enter);
$("sound-btn").addEventListener("click", () => setSound($("sound-btn").getAttribute("aria-pressed") !== "true"));
$("set-sound").addEventListener("change", (e) => setSound(e.target.checked));
// soft interface sounds: a shimmer on hover, a pop on click
document.addEventListener("pointerover", (e) => {
  const el = e.pointerType === "mouse" && e.target.closest("button, a, label.setting");
  if (el && !el.contains(e.relatedTarget)) ambient?.hover();
});
document.addEventListener("click", (e) => { if (e.target.closest("button")) ambient?.click(); }, true);
$("speak-btn").addEventListener("click", () => {
  const on = !$("speak").checked;
  setVoice(on);
  if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
});

// Files can be dropped anywhere on the page.
$("file-input").addEventListener("change", (e) => uploadMany(e.target.files));
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-veil").hidden = false; });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-veil").hidden = true; } });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop-veil").hidden = true;
  if ($("entry").hidden) uploadMany(e.dataTransfer.files);
});
$("new-upload").addEventListener("click", () => $("file-input").click());
$("close-chat").addEventListener("click", closeDoc);
$("switch-doc").addEventListener("click", openLibrary);
$("view-pdf").addEventListener("click", () => showPdf(1));
// Wide screens: closing the PDF pane closes the PDF. Phones: it just hides the overlay.
$("close-preview").addEventListener("click", () => (wide() ? closeDoc() : closePreview()));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("history").hidden) closeHistory();
  else if (!$("library").hidden) closeLibrary();
  else if (!$("preview").hidden && !wide()) closePreview();
});
$("library-btn").addEventListener("click", () => ($("library").hidden || $("library").classList.contains("closing") ? openLibrary() : closeLibrary()));
// a click outside the bubble closes it, like Settings
document.addEventListener("pointerdown", (e) => {
  if (!$("library").hidden && !$("library").contains(e.target) && !$("library-btn").contains(e.target) && !e.target.closest("[data-library], #switch-doc")) closeLibrary();
});
$("history-btn").addEventListener("click", () => ($("history").hidden ? openHistory() : closeHistory()));
// a click anywhere outside the sidebar closes it
document.addEventListener("pointerdown", (e) => {
  if (!$("history").hidden && !$("history").contains(e.target) && !$("history-btn").contains(e.target)) closeHistory();
});
$("new-chat").addEventListener("click", newChat);
$("sidebar-new-chat").addEventListener("click", newChat);
$("close-history").addEventListener("click", closeHistory);
$("history-search").addEventListener("input", renderHistory);
$("history-list").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-conv]");
  if (del) return deleteConversation(del.dataset.delConv);
  const open = e.target.closest("[data-conv]");
  if (open) openConversation(open.dataset.conv);
});
$("clear-history").addEventListener("click", async () => {
  if (!confirm("Delete all your saved chats? This can't be undone.")) return;
  try { await api("/api/conversations", { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
  state.convs = [];
  setConv(null);
  showMessages([]);
  renderHistory();
});
$("close-library").addEventListener("click", closeLibrary);
$("library-upload").addEventListener("click", () => $("file-input").click());
$("library-search").addEventListener("input", renderLibrary);
$("library-list").addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open) {
    const doc = state.docs.find((d) => d.doc_id === open.dataset.open);
    if (doc) openDoc(doc);
    closeLibrary();
    return;
  }
  const del = e.target.closest("[data-delete]");
  if (del) deleteDoc(del.dataset.delete);
});
$("home-link").addEventListener("click", (e) => {
  e.preventDefault();
  if (state.pushedApp && location.hash === "#app") history.back();   // fires popstate → page 1
  else { history.replaceState(null, "", location.pathname); showEntry(); }
});
$("signout").addEventListener("click", signOut);
document.addEventListener("click", (e) => { if (!$("signin").contains(e.target)) $("signin").open = false; });

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("question").value;
  $("question").value = "";
  $("question").style.height = "";
  send(q, "text");
});
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("question").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});
$("mic").addEventListener("click", () => (state.recording ? stopRecording() : startRecording()));

// ---------------------------------------------------------------- the cursor wave
// Moving the mouse sends a ripple through the scenery and the heading, like wind over
// water: an SVG displacement filter whose strength follows the cursor's speed, then
// settles. The filter is switched off entirely while the mouse is still (it's costly).
(function cursorWave() {
  const map = $("wavy-map"), noise = $("wavy-noise");
  const targets = [document.querySelector(".sky"), $("intro-title")];
  let px = 0, py = 0, energy = 0, seed = 0, on = false, raf = 0;
  const tick = () => {
    raf = 0;
    energy *= 0.92;
    if (energy < 0.4) {
      if (on) { targets.forEach((t) => (t.style.filter = "")); map.setAttribute("scale", "0"); on = false; }
      return;
    }
    if (!on) { targets.forEach((t) => (t.style.filter = "url(#wavy)")); on = true; }
    map.setAttribute("scale", Math.min(26, energy).toFixed(1));
    noise.setAttribute("seed", String((seed = (seed + 1) % 997)));   // keep the water moving
    raf = requestAnimationFrame(tick);
  };
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || reduced() || document.body.classList.contains("calm")) return;
    const speed = Math.hypot(e.clientX - px, e.clientY - py);
    px = e.clientX; py = e.clientY;
    energy = Math.min(30, energy + speed * 0.25);
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
})();

// header links: quick questions for the assistant
document.querySelector(".top-nav").addEventListener("click", (e) => {
  const q = e.target.closest("[data-ask]");
  if (q) send(q.dataset.ask, "text");
});

// ---------------------------------------------------------------- settings bubble

function openSettings() {
  const b = $("settings-bubble");
  if (!b.hidden && !b.classList.contains("closing")) return;
  b.hidden = false;
  b.classList.remove("closing");
  b.classList.add("popping");
  ambient?.bubble();
  $("settings-btn").setAttribute("aria-expanded", "true");
}

function closeSettings() {
  const b = $("settings-bubble");
  if (b.hidden) return;
  b.classList.remove("popping");
  b.classList.add("closing");
  $("settings-btn").setAttribute("aria-expanded", "false");
  setTimeout(() => { if (b.classList.contains("closing")) { b.hidden = true; b.classList.remove("closing"); } }, reduced() ? 0 : 300);
}

function applyNight(on) {
  document.body.classList.toggle("night", on);
  $("set-night").checked = on;
  try { localStorage.setItem("pdfa-night", on ? "1" : "0"); } catch {}
}

function applyMotion(on) {
  document.body.classList.toggle("calm", !on);
  $("set-motion").checked = on;
  scene?.setPaused(!on);
  try { localStorage.setItem("pdfa-motion", on ? "1" : "0"); } catch {}
}

(function setupSettings() {
  const wrap = $("settings");
  let hoverTimer;
  // Opens on hover (like the reference) and on click/tap; closes when you move away or press Esc.
  wrap.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { clearTimeout(hoverTimer); openSettings(); } });
  wrap.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hoverTimer = setTimeout(closeSettings, 350); });
  $("settings-btn").addEventListener("click", () => ($("settings-bubble").hidden ? openSettings() : closeSettings()));
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) closeSettings(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });
  $("set-voice").addEventListener("change", (e) => {
    setVoice(e.target.checked);
    if (!e.target.checked && "speechSynthesis" in window) speechSynthesis.cancel();
  });
  $("set-night").addEventListener("change", (e) => applyNight(e.target.checked));
  $("set-motion").addEventListener("change", (e) => applyMotion(e.target.checked));
  let night = false, motion = true;
  try { night = localStorage.getItem("pdfa-night") === "1"; motion = localStorage.getItem("pdfa-motion") !== "0"; } catch {}
  applyNight(night);
  applyMotion(motion);
  api("/api/engines").then((e) => {
    $("set-engine").textContent = e.primary === "groq" ? "Groq" : e.primary === "claude" ? "Claude" : "Local · free";
    // public demo: say plainly that uploads don't stay
    if (e.upload_ttl_hours > 0) {
      const h = e.upload_ttl_hours;
      $("demo-note").textContent = `Public demo: please don't upload anything confidential. PDFs are deleted after ${h % 24 ? `${h} hours` : h === 24 ? "24 hours" : `${h / 24} days`}.`;
      $("demo-note").hidden = false;
    }
  }).catch(() => {});
})();

// ---------------------------------------------------------------- browser edition: model download
// The first time, the three AI models (~120 MB) download into the browser's cache.
if (LOCAL) {
  const bar = document.createElement("div");
  bar.className = "model-status";
  bar.setAttribute("role", "status");
  bar.hidden = true;
  document.body.append(bar);
  addEventListener("model-progress", (e) => {
    const d = e.detail;
    bar.hidden = !d;
    if (d) bar.innerHTML = `<span>Getting the AI ready on your device (one time) · ${Math.round(d.loaded / 1e6)} of ${Math.round(d.total / 1e6)} MB</span><i style="--p:${(d.loaded / d.total).toFixed(3)}"></i>`;
  });
}

// ---------------------------------------------------------------- start

setupEntry();
(async () => {
  await loadIdentity();
  showSignInResult();
  await refreshDocs();
  renderLibrary();
  updateIntro();
  setConv(null);   // a refresh starts a fresh chat; earlier ones are under "Chats"
  renderSuggestions();
  setPlaceholder();
  placeScene();
})();
