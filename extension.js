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

// Best current estimate of how many lines fit in the visible editor area,
// learned from real scroll events as the user works (rather than guessed).
// Used to figure out exactly which line needs to be at the TOP of the
// viewport in order for the last line to land at the bottom.
let estimatedViewportLines = 50;

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

    // Applies any pending reset the moment an editor actually becomes
    // active - whether that's the user clicking a tab manually, or us
    // switching to it ourselves. This is the ONLY place resets happen now:
    // trying to reveal/scroll a BACKGROUND (non-visible) editor likely just
    // doesn't take effect in VS Code, which is almost certainly why
    // resetting the left-behind tab at switch time wasn't working - doing
    // it here guarantees we're always acting on the editor that's actually
    // on screen.
    vscode.window.onDidChangeActiveTextEditor((editor) => applyPendingReset(editor)),

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

  // Learn the real viewport height from any "normal" view (not collapsed
  // down to the isolated single line) - this gives us an accurate figure to
  // use later when repositioning a tab, instead of guessing a fixed number
  // that might be way too big or too small for the user's actual window/font.
  const visibleSpan = lastVisibleLine - firstVisibleLine + 1;
  if (!isBottomIsolated && visibleSpan > 5) {
    estimatedViewportLines = visibleSpan;
  }

  const key = document.uri.toString();
  let state = editorStates.get(key);

  log(
    `event ${shortName}: lineCount=${lineCount} visible=[${firstVisibleLine},${lastVisibleLine}]`,
    `atTop=${isAtTop} bottomIsolated=${isBottomIsolated} estimatedViewportLines=${estimatedViewportLines}`
  );

  if (!state) {
    // First time we've ever seen this editor - just record where things
    // stand, never arm a timer here (otherwise it'd fire before the user
    // did anything, e.g. a genuinely single-line file).
    state = {
      atTop: isAtTop,
      atBottomIsolated: isBottomIsolated,
      bottomTimer: null,
      topTimer: null,
      pendingReset: null
    };
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
      // Land at the top of the next file.
      const position = new vscode.Position(0, 0);
      newEditor.selection = new vscode.Selection(position, position);
      newEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } else {
      // Land at the bottom of the previous file, with the last line pinned
      // near the bottom of the viewport.
      revealNearBottom(newEditor, doc);
    }

    // Seed this editor's state as though it's already sitting at BOTH edges,
    // regardless of direction - we always land exactly at the edge we're
    // travelling toward, so seeding it "true" avoids a false transition
    // arming an immediate bounce back. Any mismatch (e.g. the other edge
    // isn't really in view) just self-corrects on the next real event.
    editorStates.set(doc.uri.toString(), {
      atTop: true,
      atBottomIsolated: true,
      bottomTimer: null,
      topTimer: null,
      pendingReset: null
    });

    // Mark the tab we're LEAVING as needing a reset - it's currently
    // sitting exactly at the edge that triggered this switch, and trying to
    // reposition it right now (while it's a background, non-visible editor)
    // doesn't reliably work. Instead the reset gets applied the moment it
    // actually becomes active again - see applyPendingReset - whether
    // that's from clicking back into it manually or another auto-switch.
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
    // Small delay so the reveal/selection calls above don't themselves
    // re-enter onVisibleRangesChanged while switching is still in progress.
    setTimeout(() => {
      switching = false;
    }, 150);
  }
}

// Called whenever ANY editor becomes active - manual click, our own
// switch, anything. If that document was left behind by an earlier
// auto-switch and is still waiting for its scroll position to be reset,
// do it now, synchronously, before returning control - so by the time the
// user actually sees/scrolls this tab, it's already back in a normal
// resting position and its "at the edge" state has been cleared. No stray
// scroll event in between can re-arm anything off the stale position.
function applyPendingReset(editor) {
  if (!editor || !editor.document) return;
  if (switching) {
    // We're already in the middle of one of our OWN programmatic switches
    // (showTextDocument itself fires this same event) - openTabAtEdge is
    // about to explicitly position this exact editor itself, so stepping in
    // here too would race with it over the same editor and could stomp on
    // the shared "switching" guard early, letting a stray scroll event
    // through mid-switch. Only handle genuine manual activations.
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
      // Was left via the bottom edge - put it back to a normal "end of
      // file" resting view instead of staying scrolled into blank space.
      revealNearBottom(editor, doc);
      state.atBottomIsolated = false;
    } else {
      // Was left via the top edge - reset to a normal "start of file" view.
      const position = new vscode.Position(0, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.Default);
      state.atTop = false;
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

// Pins the last line of doc near the BOTTOM of editor's viewport, with real
// content filling upward - not centered, and not reset to the top of the
// file the way a too-large reveal range ended up doing (if the range fully
// fits within the viewport, VS Code just anchors it at the START, which for
// most realistically-sized files meant showing from line 1 - not what we
// want here).
//
// There's no revealType for "at bottom" in the TextEditor.revealRange API
// (only Default / InCenter / InCenterIfOutsideViewport / AtTop). There IS a
// "revealLine" command that takes an explicit "at: 'bottom'" argument, but
// it only acts on whichever editor is currently ACTIVE, and its lineNumber
// indexing convention isn't something I could confirm without testing it
// live, so rather than risk revealing the wrong line I'm not using it.
//
// Instead: use AtTop, which has unambiguous, well-defined behavior (it puts
// the given line at the very top of the viewport, full stop) - and target
// it at (lastLine - estimatedViewportLines), a line computed from the ACTUAL
// measured viewport height rather than a guessed constant. If that math
// works out, real content naturally fills down from there to the last line
// at the bottom.
function revealNearBottom(editor, doc) {
  const lastLine = Math.max(doc.lineCount - 1, 0);
  // Small margin so the last line sits comfortably inside the bottom edge
  // rather than being pushed exactly onto/past it.
  const topLine = Math.max(0, lastLine - estimatedViewportLines + 3);
  const topPosition = new vscode.Position(topLine, 0);
  const lastPosition = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length);

  editor.selection = new vscode.Selection(lastPosition, lastPosition);
  editor.revealRange(new vscode.Range(topPosition, topPosition), vscode.TextEditorRevealType.AtTop);
}

function deactivate() {}

module.exports = { activate, deactivate };
