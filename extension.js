const vscode = require('vscode');

let enabled = true;
let wrapAround = false;
let triggerDelayMs = 500;

// Tracks per-document state, keyed by document URI string:
//   atTop            - was the top line the only/first thing visible last event?
//   atBottomIsolated - was the LAST line the ONLY line visible last event?
//   bottomTimer / topTimer - pending setTimeout handles for a scheduled switch
// Both edges use the same pattern: only arm a timer on the transition into
// the edge state, and only actually switch if that state has held
// continuously for triggerDelayMs (cancelled if the user scrolls away).
const editorStates = new Map();

// Guards against our own showTextDocument() calls re-triggering the handler.
let switching = false;

let statusBarItem;
let outputChannel;

function log(...parts) {
  if (!outputChannel) return;
  const time = new Date().toISOString().split('T')[1].replace('Z', '');
  outputChannel.appendLine(`[${time}] ${parts.join(' ')}`);
}

function activate(context) {
  loadConfig();
  outputChannel = vscode.window.createOutputChannel('Infinity Scroll');

  // Silently make sure there's room to scroll a short file down until only
  // its last line remains visible - no blank space below the file means no
  // way to ever reach that state, and no scroll event to detect it with.
  vscode.workspace.getConfiguration('editor').update('scrollBeyondLastLine', true, vscode.ConfigurationTarget.Global);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'infinityScroll.toggle';
  updateStatusBar();
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    outputChannel,

    vscode.commands.registerCommand('infinityScroll.toggle', () => {
      const config = vscode.workspace.getConfiguration('infinityScroll');
      config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('infinityScroll.showDebugLog', () => {
      outputChannel.show();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('infinityScroll')) {
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
  const config = vscode.workspace.getConfiguration('infinityScroll');
  enabled = config.get('enabled', true);
  wrapAround = config.get('wrapAround', false);
  triggerDelayMs = Math.max(0, config.get('triggerDelayMs', 500));
}

function updateStatusBar() {
  statusBarItem.text = `$(arrow-both) Infinity Scroll: ${enabled ? 'On' : 'Off'}`;
  statusBarItem.tooltip = 'Click to toggle scrolling across tabs';
}

function onVisibleRangesChanged(event) {
  if (!enabled) return;
  if (switching) {
    log('skip: a programmatic tab switch is in progress');
    return;
  }

  const editor = event.textEditor;
  const document = editor.document;
  const shortName = document.uri.path.split('/').pop() || document.uri.toString();

  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    log(`skip: unsupported uri scheme "${document.uri.scheme}" for ${shortName}`);
    return;
  }
  if (!event.visibleRanges || event.visibleRanges.length === 0) {
    log(`skip: empty visibleRanges for ${shortName}`);
    return;
  }

  const lineCount = document.lineCount;
  const firstVisibleLine = event.visibleRanges[0].start.line;
  const lastVisibleLine = event.visibleRanges[event.visibleRanges.length - 1].end.line;

  // "At top" = the first line is in view (normal transition-based check;
  // there's no blank space above line 1 to scroll into, so this is as
  // precise as the top edge can get).
  const isAtTop = firstVisibleLine <= 0;
  // "At bottom, isolated" = the LAST line is not just visible, but the ONLY
  // line visible - everything else in the viewport is blank scroll space.
  // This only becomes true once you've scrolled all the way, which is what
  // makes it reliable: it doesn't matter whether you got there in one fast
  // fling or many small nudges, we just check where you ARE right now.
  const isBottomIsolated = firstVisibleLine === lastVisibleLine && lastVisibleLine >= lineCount - 1;

  const key = document.uri.toString();
  let state = editorStates.get(key);

  log(
    `event ${shortName}: lineCount=${lineCount} visible=[${firstVisibleLine},${lastVisibleLine}]`,
    `atTop=${isAtTop} bottomIsolated=${isBottomIsolated}`
  );

  if (!state) {
    // First time we've ever seen this editor - just record where things
    // stand, never arm a timer here (otherwise it'd fire before the user
    // did anything, e.g. a genuinely single-line file).
    state = { atTop: isAtTop, atBottomIsolated: isBottomIsolated, bottomTimer: null, topTimer: null };
    editorStates.set(key, state);
    log(`${shortName}: first observation recorded`);
    return;
  }

  // --- Bottom edge -> next tab -------------------------------------------
  if (isBottomIsolated) {
    if (!state.atBottomIsolated && !state.bottomTimer) {
      log(`${shortName}: last line is now isolated, arming next-tab timer (${triggerDelayMs}ms)`);
      state.bottomTimer = setTimeout(() => {
        const cur = editorStates.get(key);
        if (cur) cur.bottomTimer = null;
        if (cur && cur.atBottomIsolated) {
          log(`${shortName}: bottom timer fired, switching to next tab`);
          switchTab(editor, 'next');
        } else {
          log(`${shortName}: bottom timer fired but last line no longer isolated, skipping`);
        }
      }, triggerDelayMs);
    }
  } else if (state.bottomTimer) {
    log(`${shortName}: last line no longer isolated, cancelling pending switch`);
    clearTimeout(state.bottomTimer);
    state.bottomTimer = null;
  }

  // --- Top edge -> previous tab -------------------------------------------
  if (isAtTop) {
    if (!state.atTop && !state.topTimer) {
      log(`${shortName}: entered top edge, arming previous-tab timer (${triggerDelayMs}ms)`);
      state.topTimer = setTimeout(() => {
        const cur = editorStates.get(key);
        if (cur) cur.topTimer = null;
        if (cur && cur.atTop) {
          log(`${shortName}: top timer fired, switching to previous tab`);
          switchTab(editor, 'previous');
        } else {
          log(`${shortName}: top timer fired but no longer at top, skipping`);
        }
      }, triggerDelayMs);
    }
  } else if (state.topTimer) {
    log(`${shortName}: left top edge, cancelling pending switch`);
    clearTimeout(state.topTimer);
    state.topTimer = null;
  }

  state.atTop = isAtTop;
  state.atBottomIsolated = isBottomIsolated;
}

async function switchTab(editor, direction) {
  const group = vscode.window.tabGroups.activeTabGroup;
  if (!group) {
    log('switchTab: no active tab group, aborting');
    return;
  }

  const tabs = group.tabs;
  const activeIndex = tabs.findIndex((t) => t.isActive);
  if (activeIndex === -1) {
    log('switchTab: could not find active tab in group, aborting');
    return;
  }

  const step = direction === 'next' ? 1 : -1;
  let idx = activeIndex + step;

  while (idx >= 0 && idx < tabs.length) {
    const tab = tabs[idx];
    if (tab.input instanceof vscode.TabInputText) {
      log(`switchTab: ${direction} -> found text tab at index ${idx}`);
      await openTabAtEdge(group, tab, direction);
      return;
    }
    log(`switchTab: skipping non-text tab at index ${idx}`);
    idx += step;
  }

  log(`switchTab: no text tab found going ${direction}, wrapAround=${wrapAround}`);

  if (wrapAround) {
    const orderedTabs = direction === 'next' ? tabs : [...tabs].reverse();
    const wrapTarget = orderedTabs.find(
      (t) => t.input instanceof vscode.TabInputText && t !== tabs[activeIndex]
    );
    if (wrapTarget) {
      log('switchTab: wrapping around');
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

    // Seed this editor's state as though it's already sitting at BOTH edges,
    // regardless of direction - we always land exactly at the edge we're
    // travelling toward, so seeding it "true" avoids a false transition
    // arming an immediate bounce back. Any mismatch (e.g. the other edge
    // isn't really in view) just self-corrects on the next real event.
    editorStates.set(doc.uri.toString(), {
      atTop: true,
      atBottomIsolated: true,
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
