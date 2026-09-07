import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The Slashdot popup and the engine behind the bar pill.
//
// Data flow:
//   settings (shell.json inline entry) -> resolved -> feed URL
//   feed URL change   -> drop items, load cache, refetch
//   rss.slashdot.org (curl)            -> items[] (Model.parseFeed)
//   items + resolved.lastSeen          -> unread -> bar label
//
// Opening the panel marks everything as seen (`lastSeen` persists into the
// widget's shell.json entry), but rows newer than the *previous* visit stay
// flagged for the length of that visit so you can see what arrived.
//
// Clicking a row hands the story URL to omarchy-launch-browser. Links are
// validated as http(s) in Model.cleanLink and passed as an argv vector, so
// nothing from the feed is ever interpreted by a shell.
Panel {
  id: root
  moduleName: "nazeeh.slashdot"
  ipcTarget: "nazeeh.slashdot"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ------------------------------------------------------------- settings

  readonly property var resolved: Model.resolveSettings(function(k, d) { return root.setting(k, d) })
  property string appliedFeed: ""

  // The bar injects `settings` a beat after this component is created; until
  // it lands `resolved` reports defaults. Gate write-backs behind this so a
  // fresh panel can't clobber a stored `lastSeen` with the default 0.
  property bool settingsReady: false

  // ------------------------------------------------------------- state

  property var items: []
  property bool loading: false
  // Drives the spinning refresh glyph. Distinct from `loading` so a fetch
  // that returns in 150ms still shows up as a visible spin rather than a
  // flicker — see minSpin below.
  property bool spinning: false
  property string loadError: ""
  property double lastFetch: 0
  property double now: Date.now()

  // What the "new" markers in the list are measured against: the high-water
  // mark as it stood before this visit. It lives in shell.json rather than in
  // this instance because the widget is mounted once per bar, and the panels
  // open together — a local snapshot would be taken after a sibling had
  // already advanced `lastSeen`, so every story would read as old.
  readonly property double viewedSince: resolved ? resolved.previousSeen : 0

  readonly property int unread: Model.unreadCount(items, resolved ? resolved.lastSeen : 0)
  readonly property string label: Model.barLabel(unread)
  readonly property var rows: items.slice(0, resolved ? resolved.storyCount : 15)
  readonly property string feedName: Model.feedLabel(resolved ? resolved.feed : "Main")

  // View: "main" | "settings"
  property string view: "main"
  property int cursor: -1

  readonly property bool dropdownOpen: feedDd.popupOpen || countDd.popupOpen || refreshDd.popupOpen

  // ------------------------------------------------------------- lifecycle

  function open() {
    view = "main"
    setCenterHoverRevealSuppressed(false)
    beginVisit()
    root.controller.show()
  }

  function openFromHotkey() {
    view = "main"
    beginVisit()
    root.controller.show()
    Qt.callLater(function() { if (root.opened) setCenterHoverRevealSuppressed(true) })
  }

  function openSettingsFromHotkey() {
    view = "settings"
    root.controller.show()
    Qt.callLater(function() { if (root.opened) setCenterHoverRevealSuppressed(true) })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    view = "main"
    cursor = -1
    // The bar hosts one popout at a time, so opening this widget on another
    // monitor closes this copy through closeForPopoutSwitch(). That is a
    // hand-off, not the end of the visit — retiring the banked mark there
    // would clear the "new" flags the panel being opened is about to draw.
    if (!popoutSwitchClosing) endVisit()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  // Opening is what marks the feed read: bank the old high-water mark (so
  // this visit's arrivals stay flagged), then clear the badge. Closing
  // retires the banked mark, so a reopen with no new stories flags nothing.
  function beginVisit() {
    cursor = -1
    markSeen(true)
    if (Date.now() - lastFetch > 60000) refresh()
  }

  function markSeen(startVisit) {
    persist(Model.seenUpdate(items, resolved.lastSeen, resolved.previousSeen, startVisit === true))
  }

  function endVisit() {
    persist(Model.endVisitUpdate(resolved.lastSeen, resolved.previousSeen))
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  Component.onCompleted: Qt.callLater(applyResolved)
  onResolvedChanged: applyResolved()
  onSettingsChanged: { settingsReady = true; applyResolved() }

  function applyResolved() {
    if (!resolved) return
    if (resolved.feed !== appliedFeed) {
      appliedFeed = resolved.feed
      items = []
      loadError = ""
      lastFetch = 0
      cacheFile.reload()
      refresh()
    }
    refreshTimer.interval = Math.max(60000, resolved.refreshMinutes * 60000)
  }

  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.now = Date.now() }

  Timer {
    id: refreshTimer
    interval: 900000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  // ------------------------------------------------------------- fetching

  // Slashdot serves ISO-8859-1 while most feeds are UTF-8, and Qt reads the
  // process stream as UTF-8. Round-trip the body through iconv to find out
  // which it is rather than assuming, so accented characters survive either
  // way instead of arriving as replacement glyphs.
  readonly property string fetchScript:
    'body=$(curl -fsS --max-time 15 -H "User-Agent: omarchy-slashdot/1.0" "$1") || exit 1\n' +
    'if printf %s "$body" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then printf %s "$body"\n' +
    'else printf %s "$body" | iconv -c -f ISO-8859-1 -t UTF-8; fi'

  function refresh() {
    if (feedProc.running) return
    loading = true
    spinning = true
    minSpin.restart()
    feedProc.command = ["bash", "-lc", root.fetchScript, "bash", Model.feedUrl(resolved.feed)]
    feedProc.running = true
  }

  // Both the fetch finishing and this timer call settleSpinner; whichever
  // arrives last is the one that actually stops the spin.
  Timer { id: minSpin; interval: 650; onTriggered: root.settleSpinner() }

  function settleSpinner() {
    if (Model.spinnerDone(loading, !minSpin.running)) spinning = false
  }

  Process {
    id: feedProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.loading = false
        root.settleSpinner()
        var parsed = Model.parseFeed(text)
        if (parsed.length > 0) {
          root.items = parsed
          root.loadError = ""
          root.lastFetch = Date.now()
          root.writeCache()
          // An open panel is a live visit: keep the badge cleared as stories
          // arrive, without disturbing this visit's "new" markers.
          if (root.opened) root.markSeen(false)
        } else if (root.items.length === 0) {
          root.loadError = "Couldn't load the feed"
        }
      }
    }
  }

  // ------------------------------------------------------------- cache
  //
  // Parsed stories are cached per feed so the bar badge is populated at
  // login instead of after the first fetch completes.

  readonly property string cacheDir: Quickshell.env("HOME") + "/.cache/omarchy/slashdot"

  Process { command: ["mkdir", "-p", root.cacheDir]; running: true }

  FileView {
    id: cacheFile
    path: root.cacheDir + "/" + (root.appliedFeed || "Main") + ".json"
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: root.tryCache(text())
    onLoadFailed: {}
  }

  function tryCache(raw) {
    if (items.length > 0 || !raw) return
    try {
      var data = JSON.parse(raw)
      if (data && data.feed === appliedFeed && Array.isArray(data.items)) {
        items = data.items
        lastFetch = Number(data.fetchedAt) || 0
      }
    } catch (e) {}
  }

  function writeCache() {
    cacheFile.setText(JSON.stringify({
      feed: appliedFeed, fetchedAt: lastFetch, items: items.slice(0, 50)
    }))
  }

  // ------------------------------------------------------------- persistence

  function withId(obj) {
    var out = { id: root.moduleName }
    for (var k in obj) if (k !== "id") out[k] = obj[k]
    return out
  }

  function persist(values) {
    if (!settingsReady || !values) return
    var entry = withId(root.settings)
    var changed = false
    for (var vk in values) {
      if (JSON.stringify(entry[vk]) !== JSON.stringify(values[vk])) { entry[vk] = values[vk]; changed = true }
    }
    if (!changed) return
    root.settings = entry
    if (root.hostWidget && "settings" in root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  // ------------------------------------------------------------- actions

  function openStory(item, keepOpen) {
    if (!item || !item.link) return
    Util.execArgv(["omarchy-launch-browser", item.link])
    if (!keepOpen) root.close()
  }

  function moveCursor(delta) {
    if (rows.length === 0) return
    var next = cursor + delta
    if (next < 0) next = 0
    if (next > rows.length - 1) next = rows.length - 1
    cursor = next
    list.positionViewAtIndex(cursor, ListView.Contain)
  }

  function activateCursor() {
    if (cursor >= 0 && cursor < rows.length) openStory(rows[cursor], false)
  }

  // ------------------------------------------------------------- IPC

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function settings(): void { root.openSettingsFromHotkey() }
    function refresh(): void { root.refresh() }
  }

  // ------------------------------------------------------------- UI

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property string ff: bar ? bar.fontFamily : Style.font.family
  readonly property color accent: Color.accent
  readonly property color dim: Qt.darker(fg, 1.5)

  readonly property string statusText: Model.statusLabel(spinning, loadError, lastFetch, now)

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: root.view === "settings"
      ? panel.fittedContentHeight(settingsCol.implicitHeight)
      : panel.fittedContentHeight(
          header.height + Style.space(9) + list.contentHeight + footer.height + Style.space(8),
          Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.dropdownOpen

      onCloseRequested: root.view === "settings" ? root.view = "main" : root.close()
      onTabRequested: function(direction) { if (root.view !== "settings") root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { if (root.view === "main" && dy !== 0) root.moveCursor(dy) }
      onActivateRequested: if (root.view === "main") root.activateCursor()
      onTextKey: function(t) {
        if (t === "r") root.refresh()
        else if (t === "s") root.view = root.view === "settings" ? "main" : "settings"
        else if (t === "g" && root.view === "main") root.moveCursor(-9999)
        else if (t === "G" && root.view === "main") root.moveCursor(9999)
      }

      // ============================================ MAIN VIEW

      Item {
        id: mainView
        anchors.fill: parent
        visible: root.view === "main"

        // ---- Header: feed name, refresh, settings
        Item {
          id: header
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          height: Style.space(26)

          Row {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Text {
              text: "/."
              color: root.accent
              font.family: root.ff
              font.pixelSize: Style.font.title
              font.bold: true
              anchors.verticalCenter: parent.verticalCenter
            }
            Text {
              text: root.feedName.toUpperCase()
              color: root.fg
              font.family: root.ff
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          Row {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            // Refresh, with the glyph spinning while a fetch is in flight.
            // PanelActionButton owns its icon and can't rotate it, so the
            // button carries the hover chrome and click target while the
            // glyph is drawn over it. The overlay accepts no input, so
            // clicks fall straight through to the button's MouseArea. Its
            // hoverColor defaults to `foreground`, so one color is correct
            // hovered or not.
            Item {
              implicitWidth: refreshButton.implicitWidth
              implicitHeight: refreshButton.implicitHeight

              PanelActionButton {
                id: refreshButton
                anchors.centerIn: parent
                iconText: ""
                foreground: root.fg
                tooltipText: root.spinning ? "Refreshing\u2026" : "Refresh"
                hasCursor: false
                onClicked: root.refresh()
              }

              Text {
                id: refreshGlyph
                anchors.centerIn: parent
                text: "\uf021"
                color: root.fg
                font.family: root.ff
                font.pixelSize: Style.font.icon
                transformOrigin: Item.Center

                RotationAnimation on rotation {
                  from: 0
                  to: 360
                  duration: 900
                  loops: Animation.Infinite
                  running: root.spinning
                  // Settle upright rather than freezing at whatever angle the
                  // last loop was cut off at.
                  onStopped: refreshGlyph.rotation = 0
                }
              }
            }
            PanelActionButton {
              iconText: "\uf013"
              foreground: root.fg
              tooltipText: "Settings"
              hasCursor: false
              onClicked: root.view = "settings"
            }
          }
        }

        PanelSeparator {
          id: headerRule
          anchors.top: header.bottom
          anchors.topMargin: Style.space(4)
          anchors.horizontalCenter: parent.horizontalCenter
          width: parent.width - Style.space(20)
          foreground: root.fg
        }

        // ---- Stories
        ListView {
          id: list
          anchors.top: headerRule.bottom
          anchors.topMargin: Style.space(4)
          anchors.bottom: footerRule.top
          anchors.bottomMargin: Style.space(4)
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.leftMargin: Style.space(10)
          anchors.rightMargin: Style.space(10)
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          spacing: Style.space(1)
          model: root.rows
          currentIndex: root.cursor
          highlightMoveDuration: 0
          interactive: contentHeight > height

          delegate: Rectangle {
            id: row
            required property int index
            required property var modelData

            readonly property bool hot: rowArea.containsMouse || root.cursor === index
            readonly property bool isNew: modelData.ts > root.viewedSince

            width: ListView.view ? ListView.view.width : 0
            height: rowCol.implicitHeight + Style.space(12)
            radius: Style.cornerRadius
            color: hot ? Style.hoverFillFor(root.fg, root.accent) : "transparent"

            // Unread marker: a slim accent rule down the left edge.
            Rectangle {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(2)
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(2)
              height: parent.height - Style.space(10)
              radius: width
              color: root.accent
              visible: row.isNew
            }

            Column {
              id: rowCol
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(3)

              Text {
                width: parent.width
                text: row.modelData.title
                color: row.hot ? Style.hoverStateColor(root.fg, root.accent) : root.fg
                font.family: root.ff
                font.pixelSize: Style.font.body
                font.bold: row.isNew
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              Text {
                width: parent.width
                visible: root.resolved.showSummary && text !== ""
                text: Model.snippet(row.modelData.summary, 150)
                color: root.dim
                font.family: root.ff
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
                maximumLineCount: 2
                elide: Text.ElideRight
              }

              // Meta line: section · age · comments
              Text {
                width: parent.width
                text: {
                  var parts = []
                  if (row.modelData.section) parts.push(row.modelData.section)
                  var age = Model.relativeTime(row.modelData.ts, root.now)
                  if (age) parts.push(age)
                  if (root.resolved.showComments && row.modelData.comments >= 0)
                    parts.push(row.modelData.comments + (row.modelData.comments === 1 ? " comment" : " comments"))
                  return parts.join("  ·  ")
                }
                color: Qt.darker(root.fg, 1.75)
                font.family: root.ff
                font.pixelSize: Style.font.caption
                font.letterSpacing: 0.5
                elide: Text.ElideRight
              }
            }

            MouseArea {
              id: rowArea
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              acceptedButtons: Qt.LeftButton | Qt.MiddleButton
              onEntered: root.cursor = row.index
              // Middle-click keeps the panel up, so a run of stories can be
              // sent to the browser in one visit.
              onClicked: function(mouse) {
                root.openStory(row.modelData, mouse.button === Qt.MiddleButton)
              }
            }
          }

          // Empty / error state
          Text {
            anchors.centerIn: parent
            width: parent.width - Style.space(20)
            visible: root.rows.length === 0
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            text: root.loadError !== "" ? root.loadError
                                        : (root.spinning ? "Loading stories…" : "No stories yet")
            color: root.dim
            font.family: root.ff
            font.pixelSize: Style.font.body
          }
        }

        PanelSeparator {
          id: footerRule
          anchors.bottom: footer.top
          anchors.bottomMargin: Style.space(4)
          anchors.horizontalCenter: parent.horizontalCenter
          width: parent.width - Style.space(20)
          foreground: root.fg
        }

        // ---- Footer: freshness + how to drive it
        Item {
          id: footer
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          anchors.right: parent.right
          height: Style.space(18)

          Text {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            text: root.statusText
            color: Qt.darker(root.fg, 1.7)
            font.family: root.ff
            font.pixelSize: Style.font.caption
            font.letterSpacing: 0.8
          }
          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            text: "J/K  ·  ENTER OPENS  ·  R REFRESH"
            color: Qt.darker(root.fg, 1.9)
            font.family: root.ff
            font.pixelSize: Style.font.caption
            font.letterSpacing: 0.8
          }
        }
      }

      // ============================================ SETTINGS VIEW

      Flickable {
        anchors.fill: parent
        visible: root.view === "settings"
        contentWidth: width
        contentHeight: settingsCol.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: settingsCol
          width: parent.width
          spacing: Style.space(12)
          topPadding: Style.space(2)
          bottomPadding: Style.space(4)

          // ---- Header
          Item {
            width: parent.width
            height: Style.space(22)

            Row {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(8)

              TapHandler { onTapped: root.view = "main" }
              HoverHandler { cursorShape: Qt.PointingHandCursor }

              Text {
                text: "\uf053"
                color: root.fg
                font.family: root.ff
                font.pixelSize: Style.font.bodySmall
                anchors.verticalCenter: parent.verticalCenter
              }
              Text {
                text: "SETTINGS"
                color: Qt.darker(root.fg, 1.3)
                font.family: root.ff
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1
                anchors.verticalCenter: parent.verticalCenter
              }
            }
          }

          Column {
            width: parent.width - Style.space(24)
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(10)

            PanelSectionHeader { text: "FEED"; foreground: root.fg }

            Dropdown {
              id: feedDd
              width: parent.width
              label: "Section"
              options: Model.FEEDS
              value: root.resolved.feed
              foreground: root.fg
              onChanged: root.persist({ feed: value })
            }

            Dropdown {
              id: countDd
              width: parent.width
              label: "Stories shown"
              options: Model.STORY_COUNTS
              value: String(root.resolved.storyCount)
              foreground: root.fg
              onChanged: root.persist({ storyCount: parseInt(value, 10) })
            }

            Dropdown {
              id: refreshDd
              width: parent.width
              label: "Check for new stories"
              options: Model.REFRESH_INTERVALS
              value: String(root.resolved.refreshMinutes)
              foreground: root.fg
              onChanged: root.persist({ refreshMinutes: parseInt(value, 10) })
            }

            PanelSeparator { width: parent.width; foreground: root.fg }

            Toggle {
              width: parent.width
              label: "Show summaries"
              description: "Two lines of the story blurb"
              checked: root.resolved.showSummary
              foreground: root.fg
              onClicked: root.persist({ showSummary: !root.resolved.showSummary })
            }

            Toggle {
              width: parent.width
              label: "Show comment counts"
              checked: root.resolved.showComments
              foreground: root.fg
              onClicked: root.persist({ showComments: !root.resolved.showComments })
            }
          }
        }
      }
    }
  }
}
