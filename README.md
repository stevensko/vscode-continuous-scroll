# Infinity Scroll

Makes separate open tabs feel like one continuous document. Scroll all the
way down until the last line is the only thing left in view, hold there for
a beat, and it jumps you into the top of the next tab. Scroll back up to the
top and hold there, and it jumps you into the bottom of the previous tab.

Only ever acts on real text documents (regular files and unsaved "untitled"
buffers). Terminal panels, webviews, browser previews, diff/settings views,
etc. are never affected — VS Code doesn't even fire the scroll event this
extension listens to for those, and it double-checks the document type
before doing anything.

## How it works

- **Bottom edge:** triggers when the last line of the file becomes the
  *only* line visible in the viewport — everything else on screen is blank
  scroll space. This is a state check, not a counter, so it doesn't matter
  whether you got there with one fast fling or several small nudges. Once
  that state has held continuously for the configured delay, it switches to
  the next tab and lands you at the bottom of it, using VS Code's native
  "reveal at bottom" behavior so it fills with however much real content
  actually fits your window.
- **Top edge:** requires a two-step confirmation. The first time you scroll
  back up to the very top, it doesn't arm anything - instead it nudges the
  view down by exactly one line (line 1 just slips out of view), as an "are
  you sure?" gesture. Only a genuinely separate second return to the top -
  at least a quarter second after the nudge, so residual momentum from the
  same scroll can't immediately satisfy both steps - actually arms the
  switch, held for the configured delay before it fires. An accidental
  brush against the top edge won't do anything; you have to deliberately
  return to it twice.
- Reaching an edge state cancels any pending switch immediately if you
  scroll away from it before the delay elapses.
- If the neighboring tab isn't a text document (e.g. a terminal or webview
  tab), it skips over it to find the next one that is.
- Whenever an auto-switch happens, the tab you're leaving gets its scroll
  position reset back to normal (not left sitting at the exact edge that
  triggered the switch) the moment it's next viewed - whether that's you
  clicking back into it manually, or another auto-switch. This also resets
  its "already bounced" state at the top edge, so a later return there
  requires the two-step confirmation again too.
- On activation, the extension silently turns on `editor.scrollBeyondLastLine`
  — without it there's no blank space below a short file to scroll the last
  line into isolation with, so the bottom edge could never be reached at
  all. No notification is shown for this; it just happens.

## Installing

### Option A — install the packaged extension

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the `...` menu at the top of the Extensions view → **Install from VSIX...**
3. Select the `.vsix` file.
4. Reload VS Code if prompted.

Or from the command line:

```bash
code --install-extension vscode-infinity-scroll-0.1.0.vsix
```

### Option B — run it from source (for tweaking the code)

1. Copy this folder somewhere permanent, e.g. `~/infinity-scroll`.
2. Open that folder in VS Code.
3. Press `F5`. This launches a second "Extension Development Host" window
   with the extension active — try scrolling through files there.
4. Once you're happy with it, run `npm install` then `npx vsce package`
   inside the folder to produce your own `.vsix`, and install it via
   Option A.

## Settings

Open Settings (`Ctrl+,`) and search "Infinity Scroll", or edit
`settings.json` directly:

```jsonc
{
  // Turn the whole thing on/off
  "infinityScroll.enabled": true,

  // If true, scrolling past the bottom of the last tab wraps around to the
  // first tab (and scrolling past the top of the first tab wraps to the last)
  "infinityScroll.wrapAround": false,

  // How long (ms) the last line must be the only thing visible (or the
  // first line the only thing at the top, on its second confirmed arrival)
  // before it actually switches tabs. This is the "make it less jarring"
  // knob - a quick flick through won't trigger it, but pausing there will.
  // Set to 0 to switch the instant that state is reached.
  "infinityScroll.triggerDelayMs": 500
}
```

There's also a status bar item (bottom right) you can click to toggle it on
and off quickly, and a command palette entry:
**"Infinity Scroll: Toggle On/Off"**.

## Debugging

If tab-switching isn't triggering when you expect it to, open the log via
**Command Palette → "Infinity Scroll: Show Debug Log"** (or the "Infinity
Scroll" entry in the Output panel dropdown). It logs every scroll event it
sees — `firstVisibleLine`/`lastVisibleLine`/`lineCount`, whether the bottom
is isolated, whether it's arming a switch, and why not if it isn't — useful
to paste back if you're reporting a bug.

## Known limitations

- Only affects tabs within the *same* editor group / tab bar. If you have a
  split editor, it won't jump across the split — that's intentional so it
  doesn't fight with side-by-side comparisons.
- VS Code's `editor.scrollBeyondLastLine` is a plain on/off switch, not a
  configurable line count — there's no way (from an extension or otherwise)
  to dial in an exact number of blank lines. Turning it on gives you the
  ability to scroll all the way down to the last-line-isolated state on any
  file, short or long, which is what the bottom-edge trigger relies on.
