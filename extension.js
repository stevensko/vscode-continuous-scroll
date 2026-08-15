const vscode = require('vscode');

let enabled = true;
let wrapAround = false;
let triggerDelayMs = 400;
let edgeBufferLines = 0;

// Tracks per-document state, keyed by document URI string:
//   atTop / atBottom       - was this document at the edge on the last event?
//   bottomEdgeStartLine    - firstVisibleLine at the moment we entered the bottom edge
//   bottomTimer / topTimer - pending setTimeout handles for a scheduled switch
// Used both to detect the MOMENT a scroll crosses into an edge (rather than
// re-triggering on every event while already there) and to implement the
// "dwell time" / "extra blank lines" buffers before actually switching.
const editorStates = new Map();

// Guards against our own showTextDocument() calls re-triggering the handler.
let switching = false;

let statusBarItem;
let warnedAboutScrollBeyondLastLine = false;

function activate(context) {
  loadConfig();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'continuousScroll.toggle';
  updateStatusBar();
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,

    vscode.commands.registerCommand('continuousScroll.toggle', () => {
      const config = vscode.workspace.getConfiguration('continuousScroll');
      config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('continuousScroll')) {
        loadConfig();
        updateStatusBar();
      }
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges(onVisibleRangesChanged),

    // Clean up state (and any pending timers) when a document is closed so
    // nothing leaks and nothing fires after the doc is gone.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const state = editorStates.get(doc.uri.toString());
      if (state) {
        clearTimeout(state.bottomTimer);
        clearTimeout(state.topTimer);
      }
      editorStates.delete(doc.uri.toString());
    })
  );
}

function loadConfig() {
  const config = vscode.workspace.getConfiguration('continuousScroll');
  enabled = config.get('enabled', true);
  wrapAround = config.get('wrapAround', false);
  triggerDelayMs = Math.max(0, config.get('triggerDelayMs', 400));
  edgeBufferLines = Math.max(0, config.get('edgeBufferLines', 0));
}

function updateStatusBar() {
  statusBarItem.text = `$(arrow-both) Continuous Scroll: ${enabled ? 'On' : 'Off'}`;
  statusBarItem.tooltip = 'Click to toggle scrolling across tabs';
}

function onVisibleRangesChanged(event) {
  if (!enabled || switching) return;

  const editor = event.textEditor;
  const document = editor.document;

  // Only ever act on real text documents (normal files / unsaved "untitled"
  // buffers). Terminals, webviews, diff views, output panels, etc. never
  // fire this event at all since they aren't TextEditors, but we also
  // explicitly filter by scheme as a second safety net.
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;
  if (!event.visibleRanges || event.visibleRanges.length === 0) return;

  const lineCount = document.lineCount;
  const firstVisibleLine = event.visibleRanges[0].start.line;
  const lastVisibleLine = event.visibleRanges[event.visibleRanges.length - 1].end.line;

  const isAtTop = firstVisibleLine <= 0;
  const isAtBottom = lastVisibleLine >= lineCount - 1;

  const key = document.uri.toString();
  let state = editorStates.get(key);

  if (!state) {
    // First time we've seen this editor. Just record its state - otherwise
    // a file that opens already showing its last line (e.g. a short file)
    // would instantly bounce you to the next tab before you scrolled at all.
    editorStates.set(key, {
      atTop: isAtTop,
      atBottom: isAtBottom,
      bottomEdgeStartLine: null,
      bottomTimer: null,
      topTimer: null
    });
    return;
  }

  // --- Bottom edge -> next tab -------------------------------------------
  if (isAtBottom) {
    if (!state.atBottom) {
      // Just crossed into the bottom edge.
      state.bottomEdgeStartLine = firstVisibleLine;
      maybeArmBottomTimer(editor, state, key, firstVisibleLine);
    } else if (state.bottomEdgeStartLine !== null && !state.bottomTimer) {
      // Already at the bottom edge with no timer running yet (buffer not
      // satisfied last time) - check whether we've now scrolled far enough
      // into the blank space below the file.
      maybeArmBottomTimer(editor, state, key, firstVisibleLine);
    }
  } else if (state.bottomTimer) {
    clearTimeout(state.bottomTimer);
    state.bottomTimer = null;
    state.bottomEdgeStartLine = null;
  }

  // --- Top edge -> previous tab -------------------------------------------
  if (isAtTop) {
    if (!state.atTop && !state.topTimer) {
      state.topTimer = setTimeout(() => {
        const cur = editorStates.get(key);
        if (cur) cur.topTimer = null;
        if (cur && cur.atTop) switchTab(editor, 'previous');
      }, triggerDelayMs);
    }
  } else if (state.topTimer) {
    clearTimeout(state.topTimer);
    state.topTimer = null;
  }

  state.atTop = isAtTop;
  state.atBottom = isAtBottom;
}

function maybeArmBottomTimer(editor, state, key, firstVisibleLine) {
  const drift = firstVisibleLine - state.bottomEdgeStartLine;

  if (edgeBufferLines > 0 && drift < edgeBufferLines) {
    warnIfScrollBeyondLastLineDisabled();
    return; // haven't scrolled far enough into the blank space yet
  }

  state.bottomTimer = setTimeout(() => {
    const cur = editorStates.get(key);
    if (cur) cur.bottomTimer = null;
    if (cur && cur.atBottom) switchTab(editor, 'next');
  }, triggerDelayMs);
}

function warnIfScrollBeyondLastLineDisabled() {
  if (warnedAboutScrollBeyondLastLine) return;
  const scrollBeyond = vscode.workspace.getConfiguration('editor').get('scrollBeyondLastLine');
  if (scrollBeyond) return;

  warnedAboutScrollBeyondLastLine = true;
  vscode.window
    .showWarningMessage(
      'Continuous Scroll: "continuousScroll.edgeBufferLines" needs "editor.scrollBeyondLastLine" enabled to have room to scroll into. Enable it?',
      'Enable it',
      "Don't ask again"
    )
    .then((choice) => {
      if (choice === 'Enable it') {
        vscode.workspace
          .getConfiguration('editor')
          .update('scrollBeyondLastLine', true, vscode.ConfigurationTarget.Global);
      }
    });
}

async function switchTab(editor, direction) {
  const group = vscode.window.tabGroups.activeTabGroup;
  if (!group) return;

  const tabs = group.tabs;
  const activeIndex = tabs.findIndex((t) => t.isActive);
  if (activeIndex === -1) return;

  const step = direction === 'next' ? 1 : -1;
  let idx = activeIndex + step;

  // Walk in the requested direction, skipping over any non-text tabs
  // (browser preview tabs, terminals shown as editor tabs, diff/settings
  // views, etc.) until we find another real text document.
  while (idx >= 0 && idx < tabs.length) {
    const tab = tabs[idx];
    if (tab.input instanceof vscode.TabInputText) {
      await openTabAtEdge(group, tab, direction);
      return;
    }
    idx += step;
  }

  if (wrapAround) {
    const orderedTabs = direction === 'next' ? tabs : [...tabs].reverse();
    const wrapTarget = orderedTabs.find(
      (t) => t.input instanceof vscode.TabInputText && t !== tabs[activeIndex]
    );
    if (wrapTarget) {
      await openTabAtEdge(group, wrapTarget, direction);
    }
  }
}

async function openTabAtEdge(group, tab, direction) {
  switching = true;
  try {
    const doc = await vscode.workspace.openTextDocument(tab.input.uri);
    const newEditor = await vscode.window.showTextDocument(doc, {
      viewColumn: group.viewColumn,
      preview: false
    });

    // Land at the top of the next file, or the bottom of the previous file,
    // so the direction of travel keeps making sense.
    const lastLine = Math.max(doc.lineCount - 1, 0);
    const position =
      direction === 'next'
        ? new vscode.Position(0, 0)
        : new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);

    newEditor.selection = new vscode.Selection(position, position);
    newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

    // Seed this editor's state so it doesn't immediately re-trigger another
    // jump on the very next scroll event.
    editorStates.set(doc.uri.toString(), {
      atTop: direction === 'next',
      atBottom: direction === 'previous',
      bottomEdgeStartLine: null,
      bottomTimer: null,
      topTimer: null
    });
  } finally {
    // Small delay so the reveal/selection calls above don't themselves
    // re-enter onVisibleRangesChanged while switching is still in progress.
    setTimeout(() => {
      switching = false;
    }, 150);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
