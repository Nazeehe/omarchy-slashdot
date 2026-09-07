import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar pill for the Slashdot plugin: the "/." mark plus a badge counting
// stories newer than the last time the panel was opened. Left-click opens
// the headline popup, right-click jumps to settings, middle-click refetches.
//
// The feed itself — fetching, parsing, unread bookkeeping — lives in
// Panel.qml, which the Loader keeps mounted whether or not the popup is
// visible (same arrangement as the weather widget), so the badge stays
// current without the user ever opening the panel. This file only mirrors
// the panel's `label` onto the bar.
BarWidget {
  id: root
  moduleName: "nazeeh.slashdot"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function openSettings() {
    if (panelLoader.item && panelLoader.item.openSettingsFromHotkey) panelLoader.item.openSettingsFromHotkey()
  }

  // Shape contract for shell.summon/hide/toggle routing: Bar.findPanelWidget
  // needs open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property string barLabel: panelLoader.item ? panelLoader.item.label : ""
  readonly property int unread: panelLoader.item ? panelLoader.item.unread : 0

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "nazeeh.slashdot"

    function open(): void { root.broadcast("open") }
    function close(): void { root.broadcast("close") }
    function show(): void { root.broadcast("open") }
    function hide(): void { root.broadcast("close") }
    function toggle(): void { root.broadcast("togglePanel") }
    function refresh(): void { root.broadcast("refresh") }
    function settings(): void { root.broadcast("openSettings") }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical ? "" : root.barLabel
    labelVisible: !root.vertical
    hasVisualContent: text !== ""
    active: root.unread > 0
    horizontalMargin: 8.5
    verticalPadding: 8.75
    tooltipText: root.vertical ? root.barLabel : ""

    onPressed: function(b) {
      if (b === Qt.RightButton) root.openSettings()
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
