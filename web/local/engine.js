// The browser edition's "brain": the same pipeline as the Python server, running on the
// visitor's own device. Nothing is uploaded anywhere.
//
//   PDF -> text per page (PDF.js) -> clean + chunk (each chunk keeps its page)
//   question -> embeddings pick 8 candidates -> re-ranker keeps the best 4
//            -> reader copies the exact answer span (it can't invent text)
//
// Same three small open-source models as pdf_assistant/ (ONNX, quantized), run by
// Transformers.js. The router (small talk, help, "open the lease") is a port of
// pdf_assistant/conversation.py.
//
// Pure logic, no DOM: works in the browser and in Node (tests). The Transformers.js
// module and PDF.js are passed in.

export const CHUNK_CHARS = 700;
export const OVERLAP_CHARS = 150;
export const MAX_PAGES = 300;
export const CANDIDATES = 8;
export const MIN_SCORE = 0.3;
export const RERANK_MIN = -9;
export const READER_MIN = 6;
export const MAX_ANSWER_TOKENS = 30;
export const NOT_FOUND = "I couldn't find that in this document.";
export const SECOND_PASSAGE_MARGIN = 2;

const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
const READER_MODEL = "Xenova/distilbert-base-cased-distilled-squad";

export class PDFError extends Error {}

// ---------------------------------------------------------------- PDF -> pages -> chunks

export async function extractPages(pdfjs, data) {
  const head = new TextDecoder().decode(data.slice(0, 5));
  if (!head.startsWith("%PDF")) throw new PDFError("That file isn't a PDF. Choose a file that ends in .pdf.");
  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: data.slice(0), isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") throw new PDFError("This PDF is password-protected. Remove the password and upload it again.");
    throw new PDFError("This PDF couldn't be opened. It may be damaged; try exporting it again.");
  }
  if (pdf.numPages > MAX_PAGES) throw new PDFError(`This PDF has ${pdf.numPages} pages. The limit is ${MAX_PAGES}.`);
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let text = "";
    for (const item of content.items) text += (item.str ?? "") + (item.hasEOL ? "\n" : "");
    pages.push(clean(text));
  }
  await pdf.destroy();
  if (!pages.some(Boolean)) throw new PDFError("No selectable text found. This looks like a scanned PDF, which needs OCR (not supported yet).");
  return pages;
}

export function clean(text) {
  text = text.replace(/-\n(\w)/g, "$1");          // re-join words hyphenated across lines
  // join lines wrapped mid-sentence, but keep headings (short, no closing punctuation) on their own line
  const lines = text.split("\n");
  const joined = lines.slice(0, 1);
  for (const line of lines.slice(1)) {
    const prev = joined[joined.length - 1].trim();
    const isHeading = prev.length > 0 && prev.length < 60 && !/[.,;:!?]$/.test(prev) && /^[A-Z]/.test(prev);
    if (prev && line.trim() && !isHeading) joined[joined.length - 1] += ` ${line}`;
    else joined.push(line);
  }
  return joined.join("\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n\n").trim();
}

export function split(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length > CHUNK_CHARS) {
      chunks.push(current.trim());
      current = current.slice(-OVERLAP_CHARS);
      if (current.includes(" ")) current = current.slice(current.indexOf(" ") + 1);
    }
    current += " " + s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function chunkPages(pages) {
  return pages.flatMap((text, i) => split(text).map((piece) => ({ page: i + 1, text: piece })));
}

// ---------------------------------------------------------------- the models

export function createModels(T, { onProgress } = {}) {
  const opts = { dtype: "q8", progress_callback: onProgress };
  let embedder, reranker, reader;
  const getEmbedder = () => (embedder ??= T.pipeline("feature-extraction", EMBED_MODEL, opts));
  const getReranker = () => (reranker ??= Promise.all([
    T.AutoTokenizer.from_pretrained(RERANK_MODEL, { progress_callback: onProgress }),
    T.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, opts),
  ]));
  const getReader = () => (reader ??= Promise.all([
    T.AutoTokenizer.from_pretrained(READER_MODEL, { progress_callback: onProgress }),
    T.AutoModelForQuestionAnswering.from_pretrained(READER_MODEL, opts),
  ]));

  return {
    /** One normalised vector per text (CLS pooling, like fastembed's BGE). */
    async embed(texts) {
      const model = await getEmbedder();
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = await model(texts.slice(i, i + 16), { pooling: "cls", normalize: true });
        const [rows, dim] = t.dims;
        for (let r = 0; r < rows; r++) out.push(Float32Array.from(t.data.subarray(r * dim, (r + 1) * dim)));
      }
      return out;
    },

    /** Cross-encoder scores: how well each passage answers the question. */
    async rerank(question, passages) {
      const [tok, model] = await getReranker();
      const inputs = tok(passages.map(() => question), { text_pair: passages, padding: true, truncation: true });
      const { logits } = await model(inputs);
      return Array.from(logits.data);
    },

    /** The exact answer span inside one passage, or null if the model isn't confident. */
    async extract(question, passage) {
      const [tok, model] = await getReader();
      const inputs = tok(question, { text_pair: passage, truncation: true, max_length: 384 });
      const { start_logits, end_logits } = await model(inputs);
      const ids = Array.from(inputs.input_ids.data, Number);
      const sep = tok.sep_token_id;
      const first = ids.indexOf(sep), last = ids.lastIndexOf(sep);
      const start = start_logits.data, end = end_logits.data;
      let best = -Infinity, bi = 0, bj = 0;
      for (let i = first + 1; i < last; i++) {
        for (let j = i; j < Math.min(i + MAX_ANSWER_TOKENS, last); j++) {
          if (start[i] + end[j] > best) { best = start[i] + end[j]; bi = i; bj = j; }
        }
      }
      if (best < READER_MIN) return null;
      // map the tokens back onto the passage text (decoding can add spaces around punctuation)
      const decoded = tok.decode(ids.slice(bi, bj + 1), { skip_special_tokens: true });
      const pattern = decoded.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
      const m = pattern && new RegExp(pattern, "i").exec(passage);
      if (!m) return null;
      const a = m.index, b = m.index + m[0].length;
      return { text: passage.slice(a, b).replace(/^[ ,;:]+|[ ,;:]+$/g, ""), sentence: sentenceAround(passage, a, b), score: best };
    },
  };
}

function sentenceAround(text, a, b) {
  const left = Math.max(text.lastIndexOf(". ", a - 1), text.lastIndexOf("\n", a - 1));
  const rights = [text.indexOf(". ", b), text.indexOf("\n", b)].filter((i) => i !== -1);
  const right = rights.length ? Math.min(...rights) + 1 : text.length;
  return text.slice(left + 1, right).trim();
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ---------------------------------------------------------------- search + answer

/** Two-stage retrieval inside ONE document: embeddings pick candidates, the re-ranker picks the best. */
export async function search(models, doc, question, topK = 4) {
  const [q] = await models.embed([question]);
  const scored = doc.vectors.map((v, i) => [i, dot(v, q)]).sort((x, y) => y[1] - x[1]);
  const candidates = scored.slice(0, CANDIDATES).filter(([, s]) => s >= MIN_SCORE).map(([i]) => i);
  if (!candidates.length) return [];
  const scores = await models.rerank(question, candidates.map((i) => doc.chunks[i].text));
  return candidates.map((i, k) => [i, scores[k]]).sort((x, y) => y[1] - x[1]).slice(0, topK)
    .filter(([, s]) => s >= RERANK_MIN)
    .map(([i, s]) => ({ page: doc.chunks[i].page, snippet: doc.chunks[i].text, score: s }));
}

/** Free, local answer: the reader's exact span, else the passage's 2 most relevant sentences. */
export async function answer(models, question, citations) {
  if (!citations.length) return { text: NOT_FOUND, highlight: "" };
  const spans = [];
  for (const c of citations.slice(0, 2)) {
    const s = await models.extract(question, c.snippet);
    if (s) spans.push([s, c]);
  }
  if (spans.length) {
    // prefer the re-ranker's best passage; another wins only if its answer is clearly more confident
    let [s, c] = spans[0];
    for (const [o, oc] of spans.slice(1)) if (o.score > s.score + SECOND_PASSAGE_MARGIN) [s, c] = [o, oc];
    return { text: `${s.sentence} [p. ${c.page}]`, highlight: s.text };
  }
  const best = citations[0];
  let sentences = best.snippet.split(/(?<=[.!?])\s+/).filter((s) => s.length > 3);
  if (sentences.length > 2) {
    const [q, ...vs] = await models.embed([question, ...sentences]);
    const top = vs.map((v, i) => [i, dot(v, q)]).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([i]) => i).sort((a, b) => a - b);
    sentences = top.map((i) => sentences[i]);
  }
  return { text: `${sentences.join(" ")} [p. ${best.page}]`, highlight: "" };
}

export function cleanForSpeech(text) {
  // the page is shown on screen; reading "page 5" aloud just interrupts the answer
  return text.replace(/^\([^)]*\)\s*/, "").replace(/\s*\[p\.\s*\d+\]/g, "").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- the router (port of conversation.py)

export const words = (text) => (text.toLowerCase().replace(/['’]/g, "").match(/[a-z0-9]+/g) || []);
export const docTitle = (d) => d.filename.replace(/\.pdf$/i, "");

const GREETING_CORE = new Set(["hi", "hello", "hey", "hiya", "heya", "yo", "hola", "namaste", "vanakkam", "greetings",
  "morning", "afternoon", "evening", "sup", "wassup", "whatsup", "howdy"]);
const GREETING_ALL = new Set([...GREETING_CORE, "there", "good", "whats", "what", "is", "up", "how", "are", "you", "doing",
  "it", "going", "hows", "r", "u", "ya", "today", "buddy", "friend", "dear", "all", "everyone", "again", "and", "oh", "well", "so"]);
const HOW_ARE_YOU = /\b(how are (you|u|ya)|how r u|hows it going|how is it going|whats up|what is up|wassup|whatsup|sup|how are you doing)\b/;
const THANKS = /^(ok(ay)? )?(thanks?( you| a lot| so much)?|thank u|thx|ty|cheers|great|awesome|cool|nice|perfect|got it|okay|ok|super|wonderful|amazing)( thanks?( you)?)?$/;
const BYE = /^(ok(ay)? )?(bye|goodbye|good bye|see (you|ya)( later)?|later|good night|gn|take care|thats all|that is all|im done)( bye)?$/;
const IDENTITY = /^(who|what) are (you|u)$|^(what is|whats) your name$|^are (you|u) (a )?(bot|robot|ai|human|real|person)$|^who (made|built|created) (you|u|this)$|^your name$|^introduce yourself$/;
const GUIDE = new RegExp([
  "^(help|help me|guide|guide me|tutorial|instructions|menu|start|get started|getting started|what now|what next)$",
  "\\bwhat can (you|u|i) do\\b", "\\bhow (does|do) (this|it|the app|this app|you) work\\b", "\\bhow (do|can|should) i (use|start|begin)\\b",
  "\\bhow to (use|start)\\b", "\\bwhat (do|should) i do\\b", "\\b(show|give) me (a )?(guide|tour|help)\\b", "\\bwhat is this (app|site|website|tool|page)\\b",
  "\\bhow (do|can) (you|u) help\\b", "\\bhelp me (use|with) (this|the) app\\b", "\\bwhat (are|r) (you|u) for\\b",
].join("|"));
const LIST_DOCS = /\b(what|which|list|show)\b.*\b(pdfs|files|documents|docs)\b|\bmy (pdfs|files|documents|docs|library)\b/;
const APP_WORDS = /\b(pdfs?|files?|documents?|docs?|app|here|this site|you|your|library|account|data|mic|microphone|voice)\b/;
const HOW = /\b(how|where|can|could|is|are|do|does|what|why|which|should)\b/;
const TOPICS = [
  ["upload", /\b(upload|add|import|drop|attach)\b/], ["switch", /\b(switch|change|another|other|different|choose|select|pick)\b/],
  ["voice", /\b(voice|mic|microphone|talk|speak|say|record)\b/], ["listen", /\b(read (it |answers )?aloud|listen|out loud|hear)\b/],
  ["delete", /\b(delete|remove|erase|get rid)\b/], ["privacy", /\b(private|privacy|safe|secure|security|who can see|share|shared|see my)\b/],
  ["signin", /\b(sign in|signin|log in|login|account|google)\b/], ["pages", /\b(page|pages|citation|cite|source|sources)\b/],
  ["sound", /\b(music|sound|sounds|audio)\b/],
];
const TOPIC_HELP = {
  upload: "To add PDFs, drop them anywhere on the page or tap Upload at the top. You can add many at once (up to 25 MB each). They stay on this device.",
  switch: "To switch PDFs, tap “My PDFs” at the top and pick one, use the buttons under the chat, or just tell me, like “open the warranty policy”.",
  voice: "To ask out loud, tap the mic and speak. When you stop talking, I'll answer. Voice works in Chrome, Edge and Safari.",
  listen: "To hear answers, turn on the speaker button next to the ask bar (or Settings, “Read answers aloud”). Every answer also has a Listen button.",
  delete: "To delete a PDF, open “My PDFs”, then tap the bin icon next to it. It's removed from this device.",
  privacy: "Your PDFs never leave this device: they're read and searched right here in your browser, and nothing is uploaded. Nobody else can see them.",
  signin: "There's no account needed: everything stays in this browser on this device. (Clearing the browser's site data removes your PDFs and chats.)",
  pages: "Every answer starts with the page it came from. Tap that page and the PDF opens right at it, so you can check it yourself.",
  sound: "The soft music and sounds can be switched off with the little bars button at the top, or in Settings.",
};

function nextStep(docs, current) {
  if (current) return `We're looking at ${docTitle(current)}. Ask me anything about it.`;
  if (!docs.length) return "Upload a PDF to begin, or try the sample manual.";
  if (docs.length === 1) return `Ask me anything about ${docTitle(docs[0])}, or upload another PDF.`;
  return `Pick one of your ${docs.length} PDFs below, or just tell me which one, like “open ${docTitle(docs[docs.length - 1])}”.`;
}

function guide(docs, current) {
  return "Here's how it works:\n" +
    "1. Add a PDF: tap Upload (you can add many at once).\n" +
    "2. Choose one: tap it below, open “My PDFs”, or tell me, like “open my lease agreement”.\n" +
    "3. Ask anything by typing, or tap the mic and say it.\n" +
    "4. Every answer shows its page. Tap the page to see it in the PDF.\n" +
    "Your PDFs never leave this device. " + nextStep(docs, current);
}

export function smallTalk(message, docs, current) {
  const w = words(message), text = w.join(" ");
  if (!w.length) return null;
  const many = docs.length > 1 && !current;
  if (w.every((x) => GREETING_ALL.has(x)) && (w.some((x) => GREETING_CORE.has(x)) || HOW_ARE_YOU.test(text)) && w.length <= 8) {
    const hello = HOW_ARE_YOU.test(text) ? "Hi! I'm doing great, thanks for asking." : "Hi there!";
    return { text: `${hello} I'm here to help you with your PDFs. ${nextStep(docs, current)}`, showDocs: many };
  }
  if (THANKS.test(text)) return { text: "You're welcome! Anything else you'd like to know?" };
  if (BYE.test(text)) return { text: "Bye for now! Your PDFs stay on this device and will be here when you come back." };
  if (IDENTITY.test(text)) return { text: "I'm your PDF assistant. I read the PDFs you give me and answer from them, always showing the page, so you can check. Everything runs on your device. You can type or talk to me. " + nextStep(docs, current), showDocs: many };
  if (GUIDE.test(text)) return { text: guide(docs, current), showDocs: many };
  if (LIST_DOCS.test(text) && w.length <= 8) {
    if (!docs.length) return { text: "You don't have any PDFs yet. Tap Upload to add one, or try the sample manual." };
    return { text: `You have ${docs.length} PDF${docs.length !== 1 ? "s" : ""}. Which one shall we talk about?`, showDocs: true };
  }
  if (HOW.test(text) && APP_WORDS.test(text) && w.length <= 14) {
    for (const [topic, re] of TOPICS) if (re.test(text)) return { text: TOPIC_HELP[topic] };
  }
  return null;
}

const COMMON = new Set(["the", "and", "for", "with", "from", "pdf", "file", "document", "doc", "copy", "final", "draft", "new",
  "old", "version", "sample", "scan", "scanned", "report", "manual", "guide", "notes", "of", "to", "in", "on", "a", "an", "my", "v1", "v2", "v3"]);
const SELECT_VERB = /\b(open|switch to|change to|use|talk about|talk on|chat about|look at|read|select|choose|pick|go to|show me|load|lets talk|let us talk|discuss)\b/;
const FILLER = new Set([...COMMON, "open", "switch", "change", "use", "talk", "about", "chat", "look", "at", "read", "select", "choose",
  "pick", "go", "show", "me", "load", "lets", "let", "us", "please", "can", "could", "you", "we", "i", "want", "would", "like", "to",
  "now", "one", "this", "that", "it", "ok", "okay", "so", "then", "instead", "pls", "plz", "discuss", "hey", "hi", "just", "is", "be",
  "do", "the", "start", "begin"]);

const nameWords = (d) => new Set(words(docTitle(d)).filter((t) => t.length >= 3 || /\d/.test(t)));
const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

export function findDocuments(message, docs) {
  const msg = words(message);
  const names = new Map(docs.map((d) => [d.doc_id, nameWords(d)]));
  let best = [], bestScore = 0, used = new Set();
  for (const d of docs) {
    const mine = names.get(d.doc_id);
    const others = new Set();
    for (const [id, n] of names) if (id !== d.doc_id) n.forEach((t) => others.add(t));
    const hits = new Set([...mine].filter((t) => msg.some((m) => same(t, m))));
    const distinctive = [...hits].filter((t) => !COMMON.has(t) && !others.has(t));
    const score = 2 * distinctive.length + (hits.size - distinctive.length);
    const whole = mine.size > 0 && hits.size === mine.size;
    if (!distinctive.length && !(whole && hits.size >= 2)) continue;
    if (score > bestScore) { best = [d]; bestScore = score; used = hits; }
    else if (score === bestScore) { best.push(d); hits.forEach((h) => used.add(h)); }
  }
  return [best, used];
}

const DOC_WORDS = new Set(["pdf", "document", "doc", "file", "manual", "guide", "booklet", "report", "policy", "terms"]);

/** 'How long is the warranty in the Helios manual?' -> 'How long is the warranty?'
 *  The PDF's name helps pick the document but confuses the search and the reader. */
export function stripName(message, hits) {
  const kept = message.trim().split(/\s+/).map((w) => {
    const ws = words(w);
    const named = ws.some((m) => [...hits].some((t) => same(t, m))) || (ws.length && DOC_WORDS.has(ws[0]));
    return named ? w.match(/[?.!]*$/)[0] : w;   // drop the word, keep a closing "?"
  }).filter(Boolean);
  let text = kept.join(" ")
    .replace(/\s+(in|from|of|on|about|for|inside|according to)(\s+(the|my|this|that))?\s*(?=[?.!]*$)/i, "")
    .replace(/\s+([?.!])/g, "$1").trim();
  return words(text).length >= 2 ? text : message;
}

/** Decide what to do with a message. `docs` are this device's documents, oldest first. */
export function route(message, docs, current) {
  const recent = [...docs].reverse().slice(0, 6);
  const talk = smallTalk(message, docs, current);
  if (talk) return { reply: talk.text, choices: talk.showDocs ? recent : [] };

  const [named, hits] = findDocuments(message, docs);
  const explicit = SELECT_VERB.test(words(message).join(" "));
  const rest = words(message).filter((m) => !FILLER.has(m) && ![...hits].some((t) => same(m, t)));
  const pure = rest.length <= 1 && !message.trim().endsWith("?");
  if (named.length && (!current || explicit || pure)) {
    if (named.length > 1) return { reply: "A few of your PDFs match that. Which one do you mean?", choices: named.slice(0, 6), pending: pure ? "" : message };
    const doc = named[0];
    if (pure) {
      if (current && doc.doc_id === current.doc_id) return { reply: `We're already on ${docTitle(doc)}. Ask away!` };
      return { reply: `Opened ${docTitle(doc)}. What would you like to know?`, openDoc: doc };
    }
    return { openDoc: !current || doc.doc_id !== current.doc_id ? doc : null, askDoc: doc, question: stripName(message, hits) };
  }
  if (current) return { askDoc: current };
  if (!docs.length) return { reply: "I don't have a PDF to look in yet. Tap Upload to add one, or try the sample manual, and then ask me again." };
  if (docs.length === 1) return { openDoc: docs[0], askDoc: docs[0] };
  return {
    reply: `Which PDF should I look in? Pick one below${docs.length > 6 ? ` or open “My PDFs” to search all ${docs.length}` : ""}, and I'll answer right away.`,
    choices: recent,
    pending: message,
  };
}
