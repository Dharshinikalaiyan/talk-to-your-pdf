// Browser edition: a stand-in for the Python server, running inside the page.
//
// app.js talks to "/api/..." exactly as it does with the server; in the browser edition
// those requests are answered here instead. PDFs, their search index and saved chats are
// kept in this browser (IndexedDB), so nothing ever leaves the visitor's device, and every
// visitor's library is private by construction.

import * as T from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
import { extractPages, chunkPages, createModels, search, answer, route, cleanForSpeech, docTitle, PDFError, identifiers, withoutIdentifiers } from "./engine.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_DOCS = 100;
const KEEP_CONVERSATIONS = 100;

T.env.allowLocalModels = false;   // models come from the Hugging Face hub, then the browser caches them

// ---------------------------------------------------------------- model download progress
// The first question downloads ~120 MB of models (once). Tell the page how it's going.
const progress = new Map();
let lastShown = 0;
function onProgress(p) {
  if (p.status === "progress" && p.total) progress.set(p.file + p.name, [p.loaded, p.total]);
  if (p.status !== "progress" && p.status !== "done") return;
  const now = performance.now();
  if (p.status === "progress" && now - lastShown < 250) return;
  lastShown = now;
  let loaded = 0, total = 0;
  for (const [l, t] of progress.values()) { loaded += l; total += t; }
  const busy = [...progress.values()].some(([l, t]) => l < t);
  dispatchEvent(new CustomEvent("model-progress", { detail: busy ? { loaded, total } : null }));
}
// The models run in a background worker so indexing a big PDF never freezes the page.
// If this browser can't run module workers, they run here instead (slower, but it works).
function workerModels() {
  const worker = new Worker(new URL("./models-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let next = 0;
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") return onProgress(data.p);
    const p = pending.get(data.id);
    pending.delete(data.id);
    data.error ? p?.reject(new Error(data.error)) : p?.resolve(data.result);
  };
  const call = (fn) => (...args) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
  return { embed: call("embed"), rerank: call("rerank"), extract: call("extract") };
}
let models;
try { models = workerModels(); } catch { models = createModels(T, { onProgress }); }

// Indexing progress for the page ("Reading page 12 of 300…").
const indexProgress = (text) => dispatchEvent(new CustomEvent("index-progress", { detail: text }));

// ---------------------------------------------------------------- IndexedDB

const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open("talk-to-your-pdf", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("docs", { keyPath: "doc_id" });     // info + chunks + vectors
    db.createObjectStore("files");                            // the PDF bytes, by doc_id
    db.createObjectStore("convs", { keyPath: "id" });        // saved chats
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage is full or unavailable in this browser."));
  });
}
const getAll = (store) => tx(store, "readonly", (s) => s.getAll());
const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
const put = (store, value, key) => tx(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

// documents are kept in memory too, so searching is instant
let docsCache = null;
async function allDocs() {
  docsCache ??= (await getAll("docs")).sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
  return docsCache;
}
const info = ({ doc_id, filename, pages, chunks, uploaded_at }) => ({ doc_id, filename, pages, chunks: chunks.length, uploaded_at });
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");

class HttpError extends Error {}

// ---------------------------------------------------------------- documents

async function addDocument(filename, data) {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new HttpError("That PDF is over 25 MB. Upload a smaller file.");
  const hash = await sha256(data);
  const docs = await allDocs();
  const twin = docs.find((d) => d.sha256 === hash);
  if (twin) return info(twin);
  if (docs.length >= MAX_DOCS) throw new HttpError(`You can keep up to ${MAX_DOCS} PDFs. Delete one to upload another.`);
  let pages;
  try {
    pages = await extractPages(window.pdfjsLib, new Uint8Array(data), (n, total) => {
      if (total > 5 && (n % 5 === 0 || n === total)) indexProgress(`Reading ${filename}: page ${n} of ${total}…`);
    });
  } catch (e) {
    throw new HttpError(e instanceof PDFError ? e.message : "This PDF couldn't be read.");
  }
  const chunks = chunkPages(pages);
  // embed in batches, reporting progress, so a long PDF shows it's moving
  const vectors = [];
  for (let i = 0; i < chunks.length; i += 32) {
    vectors.push(...(await models.embed(chunks.slice(i, i + 32).map((c) => c.text))));
    if (chunks.length > 32) indexProgress(`Indexing ${filename}: ${Math.min(i + 32, chunks.length)} of ${chunks.length} passages…`);
  }
  indexProgress(null);
  const doc = { doc_id: randomId(), filename: (filename || "document.pdf").split(/[\\/]/).pop().slice(0, 120), pages: pages.length,
    chunks, vectors, sha256: hash, uploaded_at: new Date().toISOString() };
  await put("files", data, doc.doc_id);
  await put("docs", doc);
  docs.push(doc);
  return info(doc);
}

async function deleteDocument(id) {
  const docs = await allDocs();
  const i = docs.findIndex((d) => d.doc_id === id);
  if (i === -1) throw new HttpError("Document not found in your library.");
  await del("docs", id);
  await del("files", id);
  docs.splice(i, 1);
  URL.revokeObjectURL(fileUrls.get(id));
  fileUrls.delete(id);
  return { deleted: id };
}

// for the PDF viewer and the "Open file" button
const fileUrls = new Map();
export async function fileData(id) {
  const data = await get("files", id);
  if (!data) throw new HttpError("Document not found in your library.");
  return new Uint8Array(data);
}
export async function fileUrl(id) {
  if (!fileUrls.has(id)) fileUrls.set(id, URL.createObjectURL(new Blob([await fileData(id)], { type: "application/pdf" })));
  return fileUrls.get(id);
}

// ---------------------------------------------------------------- chat

async function chat({ message, doc_id, conv_id }, via = "text") {
  message = (message || "").trim();
  if (!message) throw new HttpError("Type a message first.");
  if (message.length > 500) throw new HttpError("Keep messages under 500 characters.");
  const docs = await allDocs();
  const current = doc_id ? docs.find((d) => d.doc_id === doc_id) : null;
  if (doc_id && !current) throw new HttpError("Document not found in your library.");
  const r = route(message, docs.map(info), current ? info(current) : null);
  let ans;
  if (r.askDoc) {
    const doc = docs.find((d) => d.doc_id === r.askDoc.doc_id);
    const q = r.question || message;   // the PDF's name taken out
    const citations = await search(models, doc, q);
    const a = await answer(models, identifiers(q).length ? withoutIdentifiers(q) : q, citations);
    ans = { question: message, answer: a.text, citations, engine: "local", highlight: a.highlight, note: "", spoken: cleanForSpeech(a.text),
      kind: "doc", doc_id: doc.doc_id, open_doc: r.openDoc || null, choices: [], pending: "" };
  } else {
    ans = { question: message, answer: r.reply, citations: [], engine: "local", highlight: "", note: "", spoken: cleanForSpeech(r.reply.replace(/\n/g, " ")),
      kind: "chat", doc_id: r.openDoc?.doc_id || current?.doc_id || "", open_doc: r.openDoc || null, choices: r.choices || [], pending: r.pending || "" };
  }
  ans.conv_id = await saveExchange(conv_id, message, via, ans);
  return ans;
}

// ---------------------------------------------------------------- saved chats

async function saveExchange(convId, message, via, reply) {
  const now = new Date().toISOString();
  // keep page numbers, not the passage text
  const stored = { ...reply, citations: reply.citations.map((c) => ({ page: c.page, snippet: "", score: c.score })) };
  let conv = convId && (await get("convs", convId));
  if (!conv) {
    conv = { id: randomId(), title: message.slice(0, 80), created_at: now, messages: [] };
    const all = (await getAll("convs")).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const old of all.slice(KEEP_CONVERSATIONS - 1)) await del("convs", old.id);
  }
  conv.messages.push({ message: message.slice(0, 500), via, reply: stored });
  conv.updated_at = now;
  await put("convs", conv);
  return conv.id;
}

async function listConversations() {
  return (await getAll("convs")).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, messages: c.messages.length }));
}

// ---------------------------------------------------------------- the fake "/api"

export async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  const url = new URL(path, location.href);
  const p = url.pathname.replace(/^.*?\/api\//, "/api/");
  let m;

  if (p === "/api/me") return { user: "device", kind: "guest", name: "", email: "", provider: null, documents: (await allDocs()).length, providers: [] };
  if (p === "/api/engines") return { primary: "local", browser: true, upload_ttl_hours: 0 };
  if (p === "/api/documents" && method === "GET") return (await allDocs()).map(info);
  if (p === "/api/documents" && method === "POST") {
    const file = body.get("file");
    return addDocument(file.name, await file.arrayBuffer());
  }
  if (p === "/api/sample" && method === "POST") {
    const data = await (await fetch(new URL("sample_manual.pdf", location.href))).arrayBuffer();
    return addDocument("Helios H2 manual (sample).pdf", data);
  }
  if ((m = p.match(/^\/api\/documents\/([0-9a-f]{16})$/)) && method === "DELETE") return deleteDocument(m[1]);
  if (p === "/api/chat" && method === "POST") return chat(body, body.via === "voice" ? "voice" : "text");
  if (p === "/api/chat/voice" && method === "POST") return chat(body, "voice");
  if (p === "/api/conversations" && method === "GET") return listConversations();
  if (p === "/api/conversations" && method === "DELETE") {
    for (const c of await getAll("convs")) await del("convs", c.id);
    return { deleted: "all" };
  }
  if ((m = p.match(/^\/api\/conversations\/([0-9a-f]{16})$/))) {
    const conv = await get("convs", m[1]);
    if (!conv) throw new HttpError("Chat not found.");
    if (method === "DELETE") { await del("convs", m[1]); return { deleted: m[1] }; }
    return conv.messages;
  }
  throw new HttpError(`Not available in the browser edition (${method} ${p}).`);
}

/** Load the models in the background, so the first question is quick. */
export function warmUp() {
  models.embed(["warm up"]).then(() => models.rerank("warm up", ["warm up"])).then(() => models.extract("warm up?", "warm up.")).catch(() => {});
}

export { docTitle };
window.__resolveBackend?.({ request, fileData, fileUrl, warmUp });
