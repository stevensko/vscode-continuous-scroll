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
  the next tab and places your cursor at its top.
- **Top edge:** triggers when the first line comes back into view after
  having been scrolled down (there's no blank space above line 1 for VS
  Code to let you scroll into, so this edge uses a plain "you just arrived
  back at the top" check instead). Same delay applies before it switches to
  the previous tab.
- Reaching either isolated/edge state cancels the pending switch immediately
  if you scroll away from it before the delay elapses.
- If the neighboring tab isn't a text document (e.g. a terminal or webview
  tab), it skips over it to find the next one that is.
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
code --install-extension infinity-scroll-0.1.0.vsix
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
  // first line the only thing at the top) before it actually switches tabs.
  // This is the "make it less jarring" knob - a quick flick through won't
  // trigger it, but pausing there will. Set to 0 to switch the instant that
  // state is reached.
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
