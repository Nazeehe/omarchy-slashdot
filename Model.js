// Pure logic for the Slashdot widget: building feed URLs, parsing the XML
// Slashdot serves, and turning entries into rows the panel can draw.
//
// Nothing in here touches QML types — it is unit-testable with plain node
// (see tests/model.test.mjs).

// ---------------------------------------------------------------- feeds
//
// Slashdot syndicates every section at
// https://rss.slashdot.org/Slashdot/slashdot<Section>. `Main` is the
// firehose; the rest are the section front pages. Only sections that
// actually answer 200 are listed — several historical ones (Ask, BSD,
// Books) are dead and would leave the widget permanently empty.
var FEEDS = [
  { value: "Main",              label: "Slashdot" },
  { value: "Developers",        label: "Developers" },
  { value: "Linux",             label: "Linux" },
  { value: "IT",                label: "IT" },
  { value: "Hardware",          label: "Hardware" },
  { value: "Science",           label: "Science" },
  { value: "Apple",             label: "Apple" },
  { value: "Mobile",            label: "Mobile" },
  { value: "Games",             label: "Games" },
  { value: "Politics",          label: "Politics" },
  { value: "YourRightsOnline",  label: "Your Rights Online" }
]

var STORY_COUNTS = [
  { value: "10", label: "10 stories" },
  { value: "15", label: "15 stories" },
  { value: "25", label: "25 stories" },
  { value: "50", label: "50 stories" }
]

var REFRESH_INTERVALS = [
  { value: "5",   label: "Every 5 minutes" },
  { value: "15",  label: "Every 15 minutes" },
  { value: "30",  label: "Every 30 minutes" },
  { value: "60",  label: "Every hour" },
  { value: "180", label: "Every 3 hours" }
]

function knownFeed(value) {
  var wanted = String(value === undefined || value === null ? "" : value)
  for (var i = 0; i < FEEDS.length; i++)
    if (FEEDS[i].value === wanted) return FEEDS[i]
  return FEEDS[0]
}

// Section names are never interpolated raw: an unknown value (a typo, a
// hand-edited shell.json, anything path-ish) collapses to the main feed.
function feedUrl(value) {
  return "https://rss.slashdot.org/Slashdot/slashdot" + knownFeed(value).value
}

function feedLabel(value) {
  return knownFeed(value).label
}

// ---------------------------------------------------------------- settings

function clampInt(value, min, max, fallback) {
  var n = parseInt(String(value), 10)
  if (isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function asBool(value, fallback) {
  if (value === true || value === false) return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

// `get(key, fallback)` reads one field off the widget's inline shell.json
// entry. Everything is re-coerced here, so a hand-edited config can't put
// the widget into a state the UI can't represent.
function resolveSettings(get) {
  return {
    feed: knownFeed(get("feed", "Main")).value,
    storyCount: clampInt(get("storyCount", 15), 5, 50, 15),
    refreshMinutes: clampInt(get("refreshMinutes", 15), 5, 180, 15),
    showSummary: asBool(get("showSummary", true), true),
    showComments: asBool(get("showComments", true), true),
    lastSeen: clampInt(get("lastSeen", 0), 0, 8640000000000000, 0),
    previousSeen: clampInt(get("previousSeen", 0), 0, 8640000000000000, 0)
  }
}

// ---------------------------------------------------------------- visits
//
// Two numbers track what has been read. `lastSeen` is the high-water mark
// that drives the bar badge; `previousSeen` banks what it was before the
// current visit, so an open panel can still flag the stories that arrived
// since the last one.
//
// They are shared state: the widget is mounted once per bar (one per
// monitor) and every instance writes to the same shell.json entry. Both
// helpers are therefore written to be safe when a sibling has already run —
// the "nothing new" guard is what keeps a second panel's startVisit from
// banking a mark the first panel just advanced.

function seenUpdate(items, lastSeen, previousSeen, startVisit) {
  var newest = newestTimestamp(items)
  if (newest <= lastSeen) return null
  if (!startVisit) return { lastSeen: newest }
  return { lastSeen: newest, previousSeen: lastSeen }
}

function endVisitUpdate(lastSeen, previousSeen) {
  if (previousSeen === lastSeen) return null
  return { previousSeen: lastSeen }
}

// ---------------------------------------------------------------- text

var ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bull: "•", deg: "°", copy: "©", reg: "®",
  trade: "™", eacute: "é", egrave: "è", uuml: "ü",
  ouml: "ö", auml: "ä", ntilde: "ñ", laquo: "«",
  raquo: "»", frac12: "½", times: "×", minus: "−"
}

function decodeEntityToken(token) {
  if (token.charAt(0) === "#") {
    var code = token.charAt(1) === "x" || token.charAt(1) === "X"
      ? parseInt(token.slice(2), 16)
      : parseInt(token.slice(1), 10)
    if (isNaN(code) || code < 1 || code > 0x10ffff) return null
    return String.fromCodePoint(code)
  }
  var named = ENTITIES[token.toLowerCase()]
  return named === undefined ? null : named
}

// Slashdot escapes its summaries twice — the HTML body is entity-escaped,
// and the entities *inside* it are escaped again (`&amp;mdash;`). One pass
// leaves `&mdash;` on screen, so decode until the text stops changing
// (bounded, so a pathological `&amp;amp;…` chain can't spin).
function decodeEntities(text) {
  var out = String(text === undefined || text === null ? "" : text)
  for (var pass = 0; pass < 2; pass++) {
    var next = out.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      function (match, token) {
        var decoded = decodeEntityToken(token)
        return decoded === null ? match : decoded
      })
    if (next === out) break
    out = next
  }
  return out
}

// Decode before stripping: feed bodies arrive as entity-escaped HTML, so
// `&lt;p&gt;` only becomes a tag we can drop once it has been decoded. The
// second decode catches entities that were hiding inside that markup.
function stripHtml(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  return decodeEntities(decodeEntities(raw).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
}

// Feed links carry `utm_source=rss1.0mainlinkanon&utm_medium=feed`. Strip
// the tracking params, and refuse any scheme other than http(s) so a hostile
// or broken feed can't hand `xdg-open` something like a `file://` path.
function cleanLink(url) {
  var raw = String(url === undefined || url === null ? "" : url)
    .replace(/^\s+|\s+$/g, "")
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return ""

  var cut = raw.indexOf("?")
  if (cut === -1) return raw

  var base = raw.slice(0, cut)
  var parts = raw.slice(cut + 1).split("&")
  var kept = []
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue
    if (/^utm_/i.test(parts[i])) continue
    kept.push(parts[i])
  }
  return kept.length ? base + "?" + kept.join("&") : base
}

// Trim to `maxLen`, breaking on a word boundary so the ellipsis never lands
// mid-word.
function snippet(text, maxLen) {
  var s = String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")
  var limit = parseInt(String(maxLen), 10)
  if (isNaN(limit) || limit < 1 || s.length <= limit) return s

  var cut = s.slice(0, limit)
  var lastSpace = cut.lastIndexOf(" ")
  if (lastSpace > limit * 0.5) cut = cut.slice(0, lastSpace)
  return cut.replace(/[\s,.;:—-]+$/, "") + "…"
}

// ---------------------------------------------------------------- parsing

function stripCdata(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
}

// First `<tag>`/`<ns:tag>` body in `xml`, CDATA unwrapped. Prefix-agnostic so
// `dc:date` and a bare `date` both resolve.
function tagText(xml, name) {
  var re = new RegExp("<(?:[A-Za-z0-9_.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?" + name + ">", "i")
  var m = xml.match(re)
  return m ? stripCdata(m[1]) : ""
}

function firstTagText(xml, names) {
  for (var i = 0; i < names.length; i++) {
    var value = tagText(xml, names[i])
    if (value.replace(/^\s+|\s+$/g, "") !== "") return value
  }
  return ""
}

function attr(xml, name) {
  var m = xml.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '\\s*=\\s*"([^"]*)"', "i"))
  return m ? m[1] : ""
}

// Atom puts the URL in `<link rel="alternate" href="…"/>`; prefer that link
// over an enclosure or a self link.
function atomLink(xml) {
  var links = xml.match(/<link\b[^>]*\/?>/gi) || []
  var fallback = ""
  for (var i = 0; i < links.length; i++) {
    var href = decodeEntities(attr(links[i], "href"))
    if (!href) continue
    var rel = attr(links[i], "rel").toLowerCase()
    if (rel === "alternate" || rel === "") return href
    if (!fallback && rel !== "self") fallback = href
  }
  return fallback
}

function parseDate(text) {
  var raw = String(text).replace(/^\s+|\s+$/g, "")
  if (!raw) return 0
  var ms = Date.parse(raw)
  return isNaN(ms) ? 0 : ms
}

function parseEntry(xml) {
  var link = cleanLink(decodeEntities(tagText(xml, "link")) || atomLink(xml))
  if (!link) return null

  var comments = parseInt(tagText(xml, "comments"), 10)
  // RSS 2.0/Atom carry an explicit id; RSS 1.0 identifies the entry by its
  // rdf:about URL, which arrives XML-escaped and has to be decoded before
  // cleanLink can recognize its tracking parameters.
  var id = decodeEntities(firstTagText(xml, ["guid", "id"]) || attr(xml, "rdf:about")) || link

  return {
    id: cleanLink(id) || id,
    title: stripHtml(firstTagText(xml, ["title"])),
    link: link,
    summary: stripHtml(firstTagText(xml, ["description", "summary", "encoded", "content"])),
    author: stripHtml(firstTagText(xml, ["creator", "author"])),
    section: stripHtml(tagText(xml, "section")),
    department: stripHtml(tagText(xml, "department")),
    comments: isNaN(comments) ? -1 : comments,
    ts: parseDate(firstTagText(xml, ["date", "pubDate", "published", "updated"]))
  }
}

// Accepts every shape Slashdot and its mirrors serve: RSS 1.0/RDF (what
// rss.slashdot.org actually returns), RSS 2.0, and Atom. Malformed input
// yields an empty list rather than an exception — the panel shows its
// "couldn't load" state instead of taking the shell down with it.
function parseFeed(xml) {
  var text = String(xml === undefined || xml === null ? "" : xml)
  // `[\s>]` after the name keeps `<items>` (the RDF sequence) from matching.
  var blocks = text.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || []

  var out = []
  for (var i = 0; i < blocks.length; i++) {
    var entry = null
    try { entry = parseEntry(blocks[i]) } catch (e) { entry = null }
    if (entry && entry.title) out.push(entry)
  }

  // Feeds are usually ordered already; sort defensively, keeping document
  // order for entries that share (or lack) a timestamp.
  return out.map(function (item, index) {
    return { item: item, index: index }
  }).sort(function (a, b) {
    return (b.item.ts - a.item.ts) || (a.index - b.index)
  }).map(function (pair) {
    return pair.item
  })
}

// ---------------------------------------------------------------- display

function relativeTime(ts, nowMs) {
  if (!ts) return ""
  var delta = Math.max(0, nowMs - ts)
  if (delta < 60000) return "now"

  var minutes = Math.floor(delta / 60000)
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(delta / 3600000)
  if (hours < 24) return hours + "h"
  var days = Math.floor(delta / 86400000)
  if (days < 7) return days + "d"
  return Math.floor(delta / 604800000) + "w"
}

function newestTimestamp(items) {
  var newest = 0
  for (var i = 0; i < (items || []).length; i++)
    if (items[i].ts > newest) newest = items[i].ts
  return newest
}

function unreadCount(items, lastSeen) {
  var seen = parseInt(String(lastSeen), 10) || 0
  var count = 0
  for (var i = 0; i < (items || []).length; i++)
    if (items[i].ts > seen) count++
  return count
}

// A fetch on a warm connection finishes in well under 200ms — faster than a
// spinner can be read as anything but a flicker. So the refresh indicator
// runs until the fetch is done *and* a minimum spin has elapsed, whichever
// lands last.
function spinnerDone(loading, minElapsed) {
  return loading === false && minElapsed === true
}

// The panel footer. A refresh in progress outranks everything else, so a
// retry after a failure reads as a retry rather than as the stale failure.
function statusLabel(spinning, loadError, lastFetch, nowMs) {
  if (spinning) return "REFRESHING…"
  if (loadError) return String(loadError).toUpperCase()
  if (!lastFetch) return ""
  var age = relativeTime(lastFetch, nowMs)
  return age === "now" ? "UPDATED JUST NOW" : "UPDATED " + age + " AGO"
}

// The bar pill: Slashdot's own "/." mark, plus an unread badge when there
// are stories newer than the last time the panel was opened.
function barLabel(unread) {
  var n = parseInt(String(unread), 10) || 0
  if (n <= 0) return "/."
  return "/. " + (n > 99 ? "99+" : String(n))
}

if (typeof module !== "undefined") {
  module.exports = {
    FEEDS: FEEDS, STORY_COUNTS: STORY_COUNTS, REFRESH_INTERVALS: REFRESH_INTERVALS,
    feedUrl: feedUrl, feedLabel: feedLabel, resolveSettings: resolveSettings,
    decodeEntities: decodeEntities, stripHtml: stripHtml, cleanLink: cleanLink,
    snippet: snippet, parseFeed: parseFeed, relativeTime: relativeTime,
    unreadCount: unreadCount, newestTimestamp: newestTimestamp, barLabel: barLabel,
    seenUpdate: seenUpdate, endVisitUpdate: endVisitUpdate,
    spinnerDone: spinnerDone, statusLabel: statusLabel
  }
}
