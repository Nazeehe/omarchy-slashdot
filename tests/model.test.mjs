// Unit tests for Model.js — the pure logic behind the Slashdot widget.
//
// Model.js is a QML JS resource that touches no QML types, so node can
// require it directly through its module.exports guard.
// Run with:  node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const M = createRequire(import.meta.url)("../Model.js")

const fixture = fs.readFileSync(
  path.join(here, "fixtures", "slashdot-main.rss"), "latin1")

// ------------------------------------------------------------- feeds

test("feedUrl builds a section feed URL", () => {
  assert.equal(M.feedUrl("Main"), "https://rss.slashdot.org/Slashdot/slashdotMain")
  assert.equal(M.feedUrl("Linux"), "https://rss.slashdot.org/Slashdot/slashdotLinux")
})

test("feedUrl falls back to the main feed for unknown or empty sections", () => {
  assert.equal(M.feedUrl(""), "https://rss.slashdot.org/Slashdot/slashdotMain")
  assert.equal(M.feedUrl("../../etc/passwd"), "https://rss.slashdot.org/Slashdot/slashdotMain")
  assert.equal(M.feedUrl(null), "https://rss.slashdot.org/Slashdot/slashdotMain")
})

test("FEEDS is a dropdown-shaped catalogue led by the main feed", () => {
  assert.ok(M.FEEDS.length >= 8)
  assert.equal(M.FEEDS[0].value, "Main")
  for (const f of M.FEEDS) {
    assert.equal(typeof f.value, "string")
    assert.equal(typeof f.label, "string")
  }
})

test("feedLabel names a feed and degrades gracefully", () => {
  assert.equal(M.feedLabel("Main"), "Slashdot")
  assert.equal(M.feedLabel("Developers"), "Developers")
  assert.equal(M.feedLabel("Nope"), "Slashdot")
})

// ------------------------------------------------------------- settings

test("resolveSettings supplies defaults when nothing is configured", () => {
  const r = M.resolveSettings((k, d) => d)
  assert.equal(r.feed, "Main")
  assert.equal(r.storyCount, 15)
  assert.equal(r.refreshMinutes, 15)
  assert.equal(r.showSummary, true)
  assert.equal(r.showComments, true)
  assert.equal(r.lastSeen, 0)
  assert.equal(r.previousSeen, 0)
})

test("resolveSettings coerces and clamps hand-edited values", () => {
  const stored = { feed: "Linux", storyCount: "500", refreshMinutes: "0", showSummary: false }
  const r = M.resolveSettings((k, d) => (k in stored ? stored[k] : d))
  assert.equal(r.feed, "Linux")
  assert.equal(r.storyCount, 50)   // clamped to the max
  assert.equal(r.refreshMinutes, 5) // clamped to the min
  assert.equal(r.showSummary, false)
})

// ------------------------------------------------------------- text

test("decodeEntities handles named, numeric and nested entities", () => {
  assert.equal(M.decodeEntities("AT&amp;T"), "AT&T")
  assert.equal(M.decodeEntities("&lt;b&gt;hi&lt;/b&gt;"), "<b>hi</b>")
  assert.equal(M.decodeEntities("&#8212;"), "—")
  assert.equal(M.decodeEntities("&#x2014;"), "—")
  // Feed entities are escaped twice: &amp;mdash; must survive both passes.
  assert.equal(M.decodeEntities("a &amp;mdash; b"), "a — b")
})

test("stripHtml drops markup and collapses whitespace", () => {
  assert.equal(M.stripHtml("<p>one</p>\n<p>two</p>"), "one two")
  assert.equal(M.stripHtml("a<br/>b"), "a b")
  assert.equal(M.stripHtml(""), "")
  assert.equal(M.stripHtml(null), "")
})

test("cleanLink strips the feed's tracking parameters", () => {
  assert.equal(
    M.cleanLink("https://slashdot.org/story/1/x?utm_source=rss1.0mainlinkanon&utm_medium=feed"),
    "https://slashdot.org/story/1/x")
  assert.equal(
    M.cleanLink("https://slashdot.org/story/1/x?utm_source=a&id=7"),
    "https://slashdot.org/story/1/x?id=7")
  assert.equal(M.cleanLink("https://slashdot.org/x"), "https://slashdot.org/x")
})

test("cleanLink refuses anything that is not an http(s) URL", () => {
  assert.equal(M.cleanLink("javascript:alert(1)"), "")
  assert.equal(M.cleanLink("file:///etc/passwd"), "")
  assert.equal(M.cleanLink(""), "")
  assert.equal(M.cleanLink(undefined), "")
})

test("snippet trims to a word boundary and ellipsizes", () => {
  assert.equal(M.snippet("short enough", 40), "short enough")
  const s = M.snippet("the quick brown fox jumps over the lazy dog", 20)
  assert.ok(s.length <= 21)
  assert.ok(s.endsWith("…"))
  assert.ok(!s.includes("  "))
})

// ------------------------------------------------------------- parsing

test("parseFeed reads the RSS 1.0 feed Slashdot actually serves", () => {
  const items = M.parseFeed(fixture)
  assert.equal(items.length, 3)

  const first = items[0]
  assert.equal(first.title,
    "'She Lost Her Sight. Her Billionaire Father Bet On a Daring New Treatment.'")
  assert.equal(first.link,
    "https://science.slashdot.org/story/26/09/07/0036234/she-lost-her-sight-her-billionaire-father-bet-on-a-daring-new-treatment")
  assert.equal(first.author, "EditorDavid")
  assert.equal(first.section, "science")
  assert.equal(first.department, "not-giving-up")
  assert.equal(first.comments, 15)
  assert.equal(first.ts, Date.parse("2026-09-07T14:34:00+00:00"))
  assert.ok(first.summary.startsWith('"Billionaire Bill Ackman'))
  assert.ok(!first.summary.includes("<"))
  // RSS 1.0 carries no <guid>; the identity falls back to rdf:about, whose
  // XML-escaped ampersands must be decoded before the URL is cleaned.
  assert.equal(first.id, first.link)
})

test("parseFeed also reads RSS 2.0 and Atom", () => {
  const rss2 = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Two &amp; a half</title><link>https://a.example/1?utm_source=feed</link>
    <description>&lt;p&gt;body&lt;/p&gt;</description>
    <pubDate>Mon, 07 Sep 2026 14:34:00 GMT</pubDate><guid>g1</guid></item>
    </channel></rss>`
  const [a] = M.parseFeed(rss2)
  assert.equal(a.title, "Two & a half")
  assert.equal(a.link, "https://a.example/1")
  assert.equal(a.summary, "body")
  assert.equal(a.ts, Date.parse("Mon, 07 Sep 2026 14:34:00 GMT"))
  assert.equal(a.id, "g1")

  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Atom story</title><link rel="alternate" href="https://b.example/2"/>
    <summary>hello</summary><updated>2026-09-07T10:00:00Z</updated><id>x2</id></entry>
    </feed>`
  const [b] = M.parseFeed(atom)
  assert.equal(b.title, "Atom story")
  assert.equal(b.link, "https://b.example/2")
  assert.equal(b.ts, Date.parse("2026-09-07T10:00:00Z"))
})

test("parseFeed returns nothing for junk instead of throwing", () => {
  assert.deepEqual(M.parseFeed(""), [])
  assert.deepEqual(M.parseFeed("<html>404</html>"), [])
  assert.deepEqual(M.parseFeed(null), [])
})

test("parseFeed skips entries with no usable link", () => {
  const bad = `<rss><channel>
    <item><title>No link</title></item>
    <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    <item><title>Good</title><link>https://ok.example/1</link></item>
    </channel></rss>`
  const items = M.parseFeed(bad)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, "Good")
})

test("parseFeed orders newest first", () => {
  const feed = `<rss><channel>
    <item><title>old</title><link>https://e.example/1</link><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item>
    <item><title>new</title><link>https://e.example/2</link><pubDate>Fri, 05 Sep 2026 00:00:00 GMT</pubDate></item>
    </channel></rss>`
  assert.deepEqual(M.parseFeed(feed).map(i => i.title), ["new", "old"])
})

// ------------------------------------------------------------- presentation

test("relativeTime renders a compact age", () => {
  const now = Date.parse("2026-09-07T12:00:00Z")
  const ago = (ms) => M.relativeTime(now - ms, now)
  assert.equal(ago(5 * 1000), "now")
  assert.equal(ago(90 * 1000), "1m")
  assert.equal(ago(3 * 3600 * 1000), "3h")
  assert.equal(ago(50 * 3600 * 1000), "2d")
  assert.equal(ago(30 * 24 * 3600 * 1000), "4w")
  assert.equal(M.relativeTime(0, now), "")
  assert.equal(M.relativeTime(now + 60000, now), "now") // clock skew
})

test("unreadCount counts stories newer than the last visit", () => {
  const items = [{ ts: 300 }, { ts: 200 }, { ts: 100 }]
  assert.equal(M.unreadCount(items, 0), 3)
  assert.equal(M.unreadCount(items, 150), 2)
  assert.equal(M.unreadCount(items, 300), 0)
  assert.equal(M.unreadCount([], 0), 0)
})

test("newestTimestamp reports the freshest story", () => {
  assert.equal(M.newestTimestamp([{ ts: 100 }, { ts: 300 }, { ts: 200 }]), 300)
  assert.equal(M.newestTimestamp([]), 0)
})

// ------------------------------------------------------------- visit state
//
// One widget can be mounted on several bars at once (one per monitor), and
// they all share a single shell.json entry. These two helpers decide what a
// visit writes back, and every case below has a two-monitor twin where the
// second panel repeats the call a moment after the first.

test("startVisit banks the old high-water mark so this visit can flag it", () => {
  const items = [{ ts: 300 }, { ts: 200 }]
  assert.deepEqual(M.seenUpdate(items, 100, 0, true), { lastSeen: 300, previousSeen: 100 })
})

test("a second panel's startVisit does not clobber the banked mark", () => {
  const items = [{ ts: 300 }, { ts: 200 }]
  // The first panel already advanced lastSeen to 300 and banked 100.
  assert.equal(M.seenUpdate(items, 300, 100, true), null)
})

test("a fetch during an open visit advances lastSeen only", () => {
  const items = [{ ts: 400 }]
  assert.deepEqual(M.seenUpdate(items, 300, 100, false), { lastSeen: 400 })
})

test("seenUpdate writes nothing when there is nothing new", () => {
  assert.equal(M.seenUpdate([{ ts: 200 }], 300, 100, true), null)
  assert.equal(M.seenUpdate([], 0, 0, true), null)
})

test("endVisit retires the banked mark, and is idempotent across panels", () => {
  assert.deepEqual(M.endVisitUpdate(300, 100), { previousSeen: 300 })
  assert.equal(M.endVisitUpdate(300, 300), null)
})

test("barLabel shows the slash-dot mark, with a count only when unread", () => {
  assert.equal(M.barLabel(0), "/.")
  assert.equal(M.barLabel(3), "/. 3")
  assert.equal(M.barLabel(120), "/. 99+")
})
