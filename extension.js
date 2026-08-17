const vscode = require('vscode');

let enabled = true;
let wrapAround = false;
let triggerDelayMs = 500;

const editorStates = new Map();

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

    vscode.window.onDidChangeActiveTextEditor((editor) => applyPendingReset(editor)),

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

  const isAtTop = firstVisibleLine <= 0;

  const isBottomIsolated = firstVisibleLine === lastVisibleLine && lastVisibleLine >= lineCount - 1;

  const key = document.uri.toString();
  let state = editorStates.get(key);

  log(
    `event ${shortName}: lineCount=${lineCount} visible=[${firstVisibleLine},${lastVisibleLine}]`,
    `atTop=${isAtTop} bottomIsolated=${isBottomIsolated}`
  );

  if (!state) {

    state = {
      atTop: isAtTop,
      atBottomIsolated: isBottomIsolated,
      bottomTimer: null,
      topTimer: null,
      pendingReset: null,
      topBounced: false,
      topBounceTime: null
    };
    editorStates.set(key, state);
    log(`${shortName}: first observation recorded`);
    return;
  }

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

  if (isAtTop) {
    if (!state.topBounced) {

      if (!state.atTop) {
        log(`${shortName}: first arrival at top, bouncing down one line to confirm`);
        state.topBounced = true;
        state.topBounceTime = Date.now();

        setTimeout(() => bounceDownOneLine(editor, document), 0);
      }
    } else if (!state.topTimer) {

      const sinceBounce = Date.now() - (state.topBounceTime || 0);
      const bounceCooldownMs = 250;
      if (sinceBounce >= bounceCooldownMs) {
        log(`${shortName}: confirmed second arrival at top (${sinceBounce}ms after bounce), arming previous-tab timer (${triggerDelayMs}ms)`);
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
      } else {
        log(`${shortName}: back at top only ${sinceBounce}ms after bounce, still within cooldown, waiting`);
      }
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
      await openTabAtEdge(group, tab, direction, editor);
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
      await openTabAtEdge(group, wrapTarget, direction, editor);
    }
  }
}

async function openTabAtEdge(group, tab, direction, fromEditor) {
  switching = true;
  try {
    const doc = await vscode.workspace.openTextDocument(tab.input.uri);
    const newEditor = await vscode.window.showTextDocument(doc, {
      viewColumn: group.viewColumn,
      preview: false
    });

    if (direction === 'next') {

      const position = new vscode.Position(0, 0);
      newEditor.selection = new vscode.Selection(position, position);
      newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } else {

      revealNearBottom(newEditor, doc);
    }

    editorStates.set(doc.uri.toString(), {
      atTop: true,
      atBottomIsolated: true,
      bottomTimer: null,
      topTimer: null,
      pendingReset: null,
      topBounced: false,
      topBounceTime: null
    });

    if (fromEditor && fromEditor.document) {
      const fromKey = fromEditor.document.uri.toString();
      const fromState = editorStates.get(fromKey);
      if (fromState) {
        fromState.pendingReset = direction;
        clearTimeout(fromState.bottomTimer);
        clearTimeout(fromState.topTimer);
        fromState.bottomTimer = null;
        fromState.topTimer = null;
      }
    }
  } finally {

    setTimeout(() => {
      switching = false;
    }, 150);
  }
}

function applyPendingReset(editor) {
  if (!editor || !editor.document) return;
  if (switching) {

    return;
  }

  const key = editor.document.uri.toString();
  const state = editorStates.get(key);
  if (!state || !state.pendingReset) return;

  const direction = state.pendingReset;
  const doc = editor.document;
  const shortName = doc.uri.path.split('/').pop() || doc.uri.toString();

  switching = true;
  try {
    if (direction === 'next') {

      revealNearBottom(editor, doc);
      state.atBottomIsolated = false;
    } else {

      const position = new vscode.Position(0, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.Default);
      state.atTop = false;
      state.topBounced = false;
      state.topBounceTime = null;
    }
    log(`applied pending reset (${direction}) to ${shortName} on activation`);
  } catch (err) {
    log(`could not apply pending reset to ${shortName}: ${err.message}`);
  } finally {
    state.pendingReset = null;
    setTimeout(() => {
      switching = false;
    }, 150);
  }
}

function revealNearBottom(editor, doc) {
  const lastLine = Math.max(doc.lineCount - 1, 0);
  const lastPosition = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);
  editor.selection = new vscode.Selection(lastPosition, lastPosition);
  vscode.commands.executeCommand('revealLine', { lineNumber: lastLine + 1, at: 'bottom' });
}

function bounceDownOneLine(editor, doc) {
  if (doc.lineCount < 2) return;
  const position = new vscode.Position(1, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
}

function deactivate() {}

module.exports = { activate, deactivate };
