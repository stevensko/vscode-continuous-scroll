const vscode = require('vscode');

let enabled = true;
let wrapAround = false;
let triggerDelayMs = 400;
let edgeBufferLines = 0;

// Tracks per-document state, keyed by document URI string
const editorStates = new Map();

// Guards against our own showTextDocument() calls re-triggering the handler
let switching = false;

let statusBarItem;
let warnedAboutScrollBeyondLastLine = false;

function activate(context) {
  loadConfig();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'infinityScroll.toggle';
  updateStatusBar();
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,

    vscode.commands.registerCommand('infinityScroll.toggle', () => {
      const config = vscode.workspace.getConfiguration('infinityScroll');
      config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('infinityScroll')) {
        loadConfig();
        updateStatusBar();
      }
    }),

    // Sync state when switching tabs manually by clicking
    vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveEditor),

    vscode.window.onDidChangeTextEditorVisibleRanges(onVisibleRangesChanged),

    // Clean up state and pending timers when a document is closed
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
  const config = vscode.workspace.getConfiguration('infinityScroll');
  enabled = config.get('enabled', true);
  wrapAround = config.get('wrapAround', false);
  triggerDelayMs = Math.max(0, config.get('triggerDelayMs', 400));
  edgeBufferLines = Math.max(0, config.get('edgeBufferLines', 0));
}

function updateStatusBar() {
  statusBarItem.text = `$(arrow-both) Infinity Scroll: ${enabled ? 'On' : 'Off'}`;
  statusBarItem.tooltip = 'Click to toggle scrolling across tabs';
}

function onDidChangeActiveEditor(editor) {
  if (!editor || switching) return;
  const document = editor.document;
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;

  const key = document.uri.toString();
  const ranges = editor.visibleRanges;
  if (!ranges || ranges.length === 0) return;

  const lineCount = document.lineCount;
  const firstVisibleLine = ranges[0].start.line;
  const lastVisibleLine = ranges[ranges.length - 1].end.line;

  // Initialize or update state without arming timers on a click
  const existing = editorStates.get(key);
  if (existing) {
    clearTimeout(existing.bottomTimer);
    clearTimeout(existing.topTimer);
    existing.bottomTimer = null;
    existing.topTimer = null;
    existing.atTop = firstVisibleLine <= 0;
    existing.atBottom = lastVisibleLine >= lineCount - 1;
    existing.bottomEdgeStartLine = null;
  } else {
    editorStates.set(key, {
      atTop: firstVisibleLine <= 0,
      atBottom: lastVisibleLine >= lineCount - 1,
      bottomEdgeStartLine: null,
      bottomTimer: null,
      topTimer: null
    });
  }
}

function onVisibleRangesChanged(event) {
  if (!enabled || switching) return;

  const editor = event.textEditor;
  const document = editor.document;

  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;
  if (!event.visibleRanges || event.visibleRanges.length === 0) return;

  const lineCount = document.lineCount;
  const firstVisibleLine = event.visibleRanges[0].start.line;
  const lastVisibleLine = event.visibleRanges[event.visibleRanges.length - 1].end.line;

  const isAtTop = firstVisibleLine <= 0;
  const isAtBottom = lastVisibleLine >= lineCount - 1;
  const isShortFile = isAtTop && isAtBottom;

  const key = document.uri.toString();
  let state = editorStates.get(key);

  if (!state) {
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
    if (isShortFile) {
      // Short files trigger downward jump when scrolled into blank space below
      if (firstVisibleLine > 0) {
        const requiredBuffer = Math.max(1, edgeBufferLines);
        if (firstVisibleLine >= requiredBuffer && !state.bottomTimer) {
          state.bottomTimer = setTimeout(() => {
            const cur = editorStates.get(key);
            if (cur) cur.bottomTimer = null;
            if (cur && cur.atBottom) switchTab(editor, 'next');
          }, triggerDelayMs);
        }
      } else if (state.bottomTimer) {
        clearTimeout(state.bottomTimer);
        state.bottomTimer = null;
      }
    } else {
      // Standard long file logic
      if (!state.atBottom) {
        state.bottomEdgeStartLine = firstVisibleLine;
        maybeArmBottomTimer(editor, state, key, firstVisibleLine);
      } else if (state.bottomEdgeStartLine !== null && !state.bottomTimer) {
        maybeArmBottomTimer(editor, state, key, firstVisibleLine);
      }
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
    return;
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
      'Infinity Scroll: "infinityScroll.edgeBufferLines" needs "editor.scrollBeyondLastLine" enabled to have room to scroll into. Enable it?',
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

    const lastLine = Math.max(doc.lineCount - 1, 0);
    const position =
      direction === 'next'
        ? new vscode.Position(0, 0)
        : new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);

    newEditor.selection = new vscode.Selection(position, position);

    // Use Default reveal type so the target line is cleanly aligned at the edge rather than centered
    newEditor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.Default
    );

    // Seed state so entering this tab does not immediately re-trigger another jump
    editorStates.set(doc.uri.toString(), {
      atTop: direction === 'next',
      atBottom: direction === 'previous',
      bottomEdgeStartLine: null,
      bottomTimer: null,
      topTimer: null
    });
  } finally {
    setTimeout(() => {
      switching = false;
    }, 250);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
