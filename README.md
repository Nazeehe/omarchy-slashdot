# Slashdot

News for nerds in the Omarchy bar. The pill shows Slashdot's `/.` mark plus a
badge counting stories that arrived since your last look; clicking it opens a
popup of headlines, and clicking a headline opens the story in your browser.

```
/. 4        ← four stories since you last opened it
```

## Using it

| Where | Action | Result |
|-------|--------|--------|
| Bar pill | left click | open / close the headlines popup |
| Bar pill | right click | jump straight to settings |
| Bar pill | middle click | refetch the feed now |
| Story row | click | open in the browser and close the popup |
| Story row | middle click | open in the browser, leave the popup up |
| Popup | `j` / `k`, arrows | move the cursor |
| Popup | `Enter` / `Space` | open the story under the cursor |
| Popup | `g` / `G` | first / last story |
| Popup | `r` | refresh |
| Popup | `s` | toggle settings |
| Popup | `Esc` | back out of settings, or close |

Stories newer than your previous visit are shown in bold with an accent rule
down the left edge. They stay flagged for the whole visit, so opening the panel
does not make them vanish out from under you; closing it retires the flags.

While a fetch is in flight the refresh glyph spins and the footer reads
`REFRESHING…`. A warm fetch finishes in well under 200ms, so the spin is held
to a minimum duration — otherwise the feedback would land as a flicker and read
as nothing having happened.

## Settings

Right-click the pill (or press `s` in the popup):

- **Section** — the main firehose or any of Slashdot's section feeds
  (Developers, Linux, IT, Hardware, Science, Apple, Mobile, Games, Politics,
  Your Rights Online).
- **Stories shown** — 10, 15, 25 or 50.
- **Check for new stories** — every 5 minutes to every 3 hours.
- **Show summaries** — two lines of the story blurb under each headline.
- **Show comment counts** — Slashdot's live comment tally per story.

Settings persist inline on the widget's entry in `~/.config/omarchy/shell.json`,
alongside `lastSeen` / `previousSeen` (the read bookkeeping behind the badge).

## Install

```bash
omarchy plugin enable nazeeh.slashdot          # bar > right, by default
omarchy bar move nazeeh.slashdot --section center
```

## IPC

```bash
omarchy-shell nazeeh.slashdot open
omarchy-shell nazeeh.slashdot toggle
omarchy-shell nazeeh.slashdot settings
omarchy-shell nazeeh.slashdot refresh
omarchy-shell nazeeh.slashdot close
```

Handy as a Hyprland bind, e.g. in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER CTRL", "N", "omarchy-shell nazeeh.slashdot toggle")
```

## How it works

- `Model.js` — pure logic: feed URLs, RSS 1.0 / RSS 2.0 / Atom parsing, entity
  and HTML cleanup, relative times, and the read/unread bookkeeping. No QML
  types, so it runs under plain node.
- `Panel.qml` — the popup and the engine behind the pill: fetches through
  `curl`, caches parsed stories under `~/.cache/omarchy/slashdot/<feed>.json`
  so the badge is populated at login, and persists settings back into
  `shell.json`.
- `BarWidget.qml` — the pill itself, mirroring the panel's label.

Feeds come from `https://rss.slashdot.org/Slashdot/slashdot<Section>`. Slashdot
serves ISO-8859-1; the fetch round-trips the body through `iconv` to detect the
encoding rather than assuming it. Story links are validated as `http(s)` and
handed to `omarchy-launch-browser` as an argv vector, so nothing from the feed
is ever interpreted by a shell.

The widget is mounted once per bar — one per monitor — and all copies share the
single `shell.json` entry, so the read bookkeeping is written to be safe when a
sibling has already run.

## Tests

```bash
node --test tests/model.test.mjs
```

Covers feed URL building, the three feed dialects (against a captured slice of
the real Slashdot feed), entity/HTML cleanup, tracking-parameter stripping,
link scheme validation, relative times, the multi-monitor visit bookkeeping,
and the refresh indicator's state rules.

## License

MIT.
