"""
CONCEPT: a small "router" in front of the RAG pipeline (no AI model needed).

Not every message is a question about a PDF. Before searching, each message is sorted:

    "hi, what's up?"                  -> small talk       -> a friendly canned reply
    "how do I upload?" / "help"       -> app guide        -> step-by-step help
    "open the helios manual"          -> pick a document  -> open it, ask what they want to know
    "warranty in the helios manual?"  -> pick + question  -> open it AND answer from it
    "how long is the warranty?"       -> a document question -> the PDF that's open
                                         (none open: the only PDF, or "which one?")

This is classic NLP intent detection: normalise the text, match word patterns, and match
words against the user's own file names. It's fast, free, predictable, and keeps the
retrieval step for real questions. Only the user's own documents are ever considered.
"""

import re
from dataclasses import dataclass, field

from .models import DocumentInfo

# ---------------------------------------------------------------- text helpers


def words(text: str) -> list[str]:
    """Lowercase words, with apostrophes dropped so "what's" == "whats"."""
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", "").replace("’", ""))


def doc_title(doc: DocumentInfo) -> str:
    return re.sub(r"\.pdf$", "", doc.filename, flags=re.I)


# ---------------------------------------------------------------- small talk + the app guide

GREETING_CORE = {"hi", "hello", "hey", "hiya", "heya", "yo", "hola", "namaste", "vanakkam", "greetings",
                 "morning", "afternoon", "evening", "sup", "wassup", "whatsup", "howdy"}
GREETING_ALL = GREETING_CORE | {
    "there", "good", "whats", "what", "is", "up", "how", "are", "you", "doing", "it", "going", "hows",
    "r", "u", "ya", "today", "buddy", "friend", "dear", "all", "everyone", "again", "and", "oh", "well", "so",
}
HOW_ARE_YOU = re.compile(r"\b(how are (you|u|ya)|how r u|hows it going|how is it going|whats up|what is up|wassup|whatsup|sup|how are you doing)\b")
THANKS = re.compile(r"^(ok(ay)? )?(thanks?( you| a lot| so much)?|thank u|thx|ty|cheers|great|awesome|cool|nice|perfect|got it|okay|ok|super|wonderful|amazing)( thanks?( you)?)?$")
BYE = re.compile(r"^(ok(ay)? )?(bye|goodbye|good bye|see (you|ya)( later)?|later|good night|gn|take care|thats all|that is all|im done)( bye)?$")
IDENTITY = re.compile(r"^(who|what) are (you|u)$|^(what is|whats) your name$|^are (you|u) (a )?(bot|robot|ai|human|real|person)$|^who (made|built|created) (you|u|this)$|^your name$|^introduce yourself$")
GUIDE = re.compile(
    r"^(help|help me|guide|guide me|tutorial|instructions|menu|start|get started|getting started|what now|what next)$"
    r"|\bwhat can (you|u|i) do\b|\bhow (does|do) (this|it|the app|this app|you) work\b|\bhow (do|can|should) i (use|start|begin)\b"
    r"|\bhow to (use|start)\b|\bwhat (do|should) i do\b|\b(show|give) me (a )?(guide|tour|help)\b|\bwhat is this (app|site|website|tool|page)\b"
    r"|\bhow (do|can) (you|u) help\b|\bhelp me (use|with) (this|the) app\b|\bwhat (are|r) (you|u) for\b"
)
LIST_DOCS = re.compile(r"\b(what|which|list|show)\b.*\b(pdfs|files|documents|docs)\b|\bmy (pdfs|files|documents|docs|library)\b")
# app how-to topics. They only count when the message is clearly about the app, so a
# manual's own "how do I delete the error log?" still goes to the PDF.
APP_WORDS = re.compile(r"\b(pdfs?|files?|documents?|docs?|app|here|this site|you|your|library|account|data|mic|microphone|voice)\b")
HOW = re.compile(r"\b(how|where|can|could|is|are|do|does|what|why|which|should)\b")
TOPICS = [
    ("upload", re.compile(r"\b(upload|add|import|drop|attach)\b")),
    ("switch", re.compile(r"\b(switch|change|another|other|different|choose|select|pick)\b")),
    ("voice", re.compile(r"\b(voice|mic|microphone|talk|speak|say|record)\b")),
    ("listen", re.compile(r"\b(read (it |answers )?aloud|listen|out loud|hear)\b")),
    ("delete", re.compile(r"\b(delete|remove|erase|get rid)\b")),
    ("privacy", re.compile(r"\b(private|privacy|safe|secure|security|who can see|share|shared|see my)\b")),
    ("signin", re.compile(r"\b(sign in|signin|log in|login|account|google)\b")),
    ("pages", re.compile(r"\b(page|pages|citation|cite|source|sources)\b")),
    ("sound", re.compile(r"\b(music|sound|sounds|audio)\b")),
]

TOPIC_HELP = {
    "upload": "To add PDFs, drop them anywhere on the upload button or tap Upload at the top. You can add many at once (up to 25 MB each).",
    "switch": "To switch PDFs, tap “My PDFs” at the top and pick one, use the chips under the chat, or just tell me, like “open the warranty policy”.",
    "voice": "To ask out loud, tap the mic, speak your question, then tap it again. I'll work out the words and answer.",
    "listen": "To hear answers, turn on the speaker button next to the ask bar (or Settings, “Read answers aloud”). Every answer also has a Listen button.",
    "delete": "To delete a PDF, open “My PDFs”, then tap the bin icon next to it. It's removed from your library for good.",
    "privacy": "Your PDFs are private to you. Nobody else can list, open or search them. As a guest they belong to this browser; sign in with Google to keep them with your account on any device.",
    "signin": "Tap “Sign in” at the top to use your Google account. Any PDFs you added as a guest move into your account.",
    "pages": "Every answer starts with the page it came from. Tap that page chip and the PDF opens right at that page, so you can check it yourself.",
    "sound": "The soft music and sounds can be switched off with the little bars button at the top, or in Settings.",
}


def _next_step(docs: list[DocumentInfo], current: DocumentInfo | None) -> str:
    if current:
        return f"We're looking at {doc_title(current)}. Ask me anything about it."
    if not docs:
        return "Upload a PDF to begin, or try the sample manual."
    if len(docs) == 1:
        return f"Ask me anything about {doc_title(docs[0])}, or upload another PDF."
    return f"Pick one of your {len(docs)} PDFs below, or just tell me which one, like “open {doc_title(docs[-1])}”."


def guide(docs: list[DocumentInfo], current: DocumentInfo | None) -> str:
    return (
        "Here's how it works:\n"
        "1. Add a PDF: tap Upload (you can add many at once).\n"
        "2. Choose one: tap it below, open “My PDFs”, or tell me, like “open my lease agreement”.\n"
        "3. Ask anything by typing, or tap the mic and say it.\n"
        "4. Every answer shows its page. Tap the page to see it in the PDF.\n"
        "Your PDFs are private to you. " + _next_step(docs, current)
    )


@dataclass
class Reply:
    text: str
    show_docs: bool = False      # show the user's PDFs as choices under the reply


def small_talk(message: str, docs: list[DocumentInfo], current: DocumentInfo | None) -> Reply | None:
    """A canned reply for greetings, thanks, "who are you", and how-to-use questions; else None."""
    w = words(message)
    text = " ".join(w)
    if not w:
        return None
    many = len(docs) > 1 and not current

    if set(w) <= GREETING_ALL and (set(w) & GREETING_CORE or HOW_ARE_YOU.search(text)) and len(w) <= 8:
        hello = "Hi! I'm doing great, thanks for asking." if HOW_ARE_YOU.search(text) else "Hi there!"
        return Reply(f"{hello} I'm here to help you with your PDFs. {_next_step(docs, current)}", show_docs=many)
    if THANKS.match(text):
        return Reply("You're welcome! Anything else you'd like to know?")
    if BYE.match(text):
        return Reply("Bye for now! Your PDFs stay private and will be here when you come back.")
    if IDENTITY.match(text):
        return Reply(
            "I'm your PDF assistant. I read the PDFs you give me and answer from them, always showing the page, "
            f"so you can check. You can type or talk to me. {_next_step(docs, current)}",
            show_docs=many,
        )
    if GUIDE.search(text):
        return Reply(guide(docs, current), show_docs=many)
    if LIST_DOCS.search(text) and len(w) <= 8:
        if not docs:
            return Reply("You don't have any PDFs yet. Tap Upload to add one, or try the sample manual.")
        return Reply(f"You have {len(docs)} PDF{'s' if len(docs) != 1 else ''}. Which one shall we talk about?", show_docs=True)
    if HOW.search(text) and APP_WORDS.search(text) and len(w) <= 14:
        for topic, pattern in TOPICS:
            if pattern.search(text):
                return Reply(TOPIC_HELP[topic])
    return None


# ---------------------------------------------------------------- "which PDF?" by name

# words too common in file names to identify one
COMMON = {"the", "and", "for", "with", "from", "pdf", "file", "document", "doc", "copy", "final", "draft", "new",
          "old", "version", "sample", "scan", "scanned", "report", "manual", "guide", "notes", "of", "to", "in", "on",
          "a", "an", "my", "v1", "v2", "v3"}
SELECT_VERB = re.compile(r"\b(open|switch to|change to|use|talk about|talk on|chat about|look at|read|select|choose|pick|go to|show me|load|lets talk|let us talk|discuss)\b")
FILLER = COMMON | {"open", "switch", "change", "use", "talk", "about", "chat", "look", "at", "read", "select", "choose",
                   "pick", "go", "show", "me", "load", "lets", "let", "us", "please", "can", "could", "you", "we", "i",
                   "want", "would", "like", "to", "now", "one", "this", "that", "it", "ok", "okay", "so", "then",
                   "instead", "pls", "plz", "discuss", "hey", "hi", "just", "is", "be", "do", "the", "start", "begin"}


def _name_words(doc: DocumentInfo) -> set[str]:
    return {t for t in words(doc_title(doc)) if (len(t) >= 3 or any(ch.isdigit() for ch in t))}


def _same(a: str, b: str) -> bool:
    # "invoice" matches "invoices"; short words must match exactly
    return a == b or (min(len(a), len(b)) >= 5 and (a.startswith(b) or b.startswith(a)))


def find_documents(message: str, docs: list[DocumentInfo]) -> tuple[list[DocumentInfo], set[str]]:
    """Documents the message names, best first (several only if it's a tie), and the words that named them."""
    msg = words(message)
    names = {d.doc_id: _name_words(d) for d in docs}
    best, best_score, used = [], 0, set()
    for d in docs:
        others = set().union(*(n for i, n in names.items() if i != d.doc_id)) if len(docs) > 1 else set()
        hits = {t for t in names[d.doc_id] for m in msg if _same(t, m)}
        distinctive = {t for t in hits if t not in COMMON and t not in others}
        score = 2 * len(distinctive) + len(hits - distinctive)
        whole = bool(names[d.doc_id]) and hits == names[d.doc_id]
        if not distinctive and not (whole and len(hits) >= 2):
            continue
        if score > best_score:
            best, best_score, used = [d], score, hits
        elif score == best_score:
            best.append(d)
            used |= hits
    return best, used


def _leftover(message: str, name_hits: set[str]) -> list[str]:
    """What's left of the message once the document's name and "open / talk about" words are removed."""
    return [m for m in words(message) if m not in FILLER and not any(_same(m, t) for t in name_hits)]


# ---------------------------------------------------------------- the router


@dataclass
class Route:
    reply: str = ""                       # say this (no document search)
    open_doc: DocumentInfo | None = None  # switch the conversation to this document
    ask_doc: DocumentInfo | None = None   # answer the question from this document
    choices: list[DocumentInfo] = field(default_factory=list)  # let the user pick one
    pending: str = ""                     # the question to answer once they've picked


def route(message: str, docs: list[DocumentInfo], current: DocumentInfo | None) -> Route:
    """Decide what to do with a message. `docs` are the caller's own documents, oldest first."""
    recent = list(reversed(docs))[:6]

    talk = small_talk(message, docs, current)
    if talk:
        return Route(reply=talk.text, choices=recent if talk.show_docs else [])

    named, hits = find_documents(message, docs)
    explicit = bool(SELECT_VERB.search(" ".join(words(message))))
    rest = _leftover(message, hits)
    pure = len(rest) <= 1 and not message.strip().endswith("?")
    # With a PDF already open, only switch when they clearly ask to (or only name the other one),
    # so a question that happens to contain another file's name stays on the open PDF.
    if named and (current is None or explicit or pure):
        if len(named) > 1:
            return Route(reply="A few of your PDFs match that. Which one do you mean?", choices=named[:6],
                         pending="" if pure else message)
        doc = named[0]
        if pure:
            if current and doc.doc_id == current.doc_id:
                return Route(reply=f"We're already on {doc_title(doc)}. Ask away!")
            return Route(reply=f"Opened {doc_title(doc)}. What would you like to know?", open_doc=doc)
        return Route(open_doc=doc if not current or doc.doc_id != current.doc_id else None, ask_doc=doc)

    if current:
        return Route(ask_doc=current)
    if not docs:
        return Route(reply="I don't have a PDF to look in yet. Tap Upload to add one, or try the sample manual, and then ask me again.")
    if len(docs) == 1:
        return Route(open_doc=docs[0], ask_doc=docs[0])
    return Route(
        reply=f"Which PDF should I look in? Pick one below{' or open “My PDFs” to search all ' + str(len(docs)) if len(docs) > 6 else ''}, and I'll answer right away.",
        choices=recent,
        pending=message,
    )
