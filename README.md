# VSCode Continuous Scroll

Makes separate open tabs feel like one continuous document. Scroll past the
bottom of a file and it jumps you into the top of the next tab. Scroll back
up past the top and it jumps you into the bottom of the previous tab.

Only ever acts on real text documents (regular files and unsaved "untitled"
buffers). Terminal panels, webviews, browser previews, diff/settings views,
etc. are never affected — VS Code doesn't even fire the scroll event this
extension listens to for those, and it double-checks the document type
before doing anything.

## How it works

- Listens for scroll position changes in the active editor.
- The moment the bottom line of the file first becomes visible (i.e. you
  just scrolled into it, not just opened a short file that already shows
  its last line), it switches to the next tab in the same tab group and
  places your cursor at its top.
- The moment the top line first becomes visible after having been scrolled
  down, it switches to the previous tab and places your cursor at its
  bottom.
- If the neighboring tab isn't a text document (e.g. a terminal or webview
  tab), it skips over it to find the next one that is.

## Installing

### Option A — install the packaged extension

1. Open the Extensions view in VS Code (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the `...` menu at the top of the Extensions view → **Install from VSIX...**
3. Select `continuous-scroll-0.0.1.vsix`.
4. Reload VS Code if prompted.

Or from the command line:

```bash
code --install-extension continuous-scroll-0.0.1.vsix
```

### Option B — run it from source (for tweaking the code)

1. Copy this folder somewhere permanent, e.g. `~/continuous-scroll`.
2. Open that folder in VS Code.
3. Press `F5`. This launches a second "Extension Development Host" window
   with the extension active — try scrolling through files there.
4. Once you're happy with it, run `npm install` then `npx vsce package`
   inside the folder to produce your own `.vsix`, and install it via
   Option A.

## Settings

Open Settings (`Ctrl+,`) and search "Continuous Scroll", or edit
`settings.json` directly:

```jsonc
{
  // Turn the whole thing on/off
  "continuousScroll.enabled": true,

  // If true, scrolling past the bottom of the last tab wraps around to the
  // first tab (and scrolling past the top of the first tab wraps to the last)
  "continuousScroll.wrapAround": false,

  // How long (ms) you must stay scrolled at the top/bottom edge before it
  // actually switches tabs. This is the main "make it less jarring" knob:
  // a quick flick past the edge won't trigger it, but pausing there - or
  // continuing to scroll - will. Set to 0 for the old instant behavior.
  "continuousScroll.triggerDelayMs": 400,

  // Extra blank lines you must scroll past the END of a file before the
  // countdown above even starts. Needs "editor.scrollBeyondLastLine": true,
  // since that's what creates blank space to scroll into in the first
  // place. Only affects going to the NEXT tab - there's no blank space
  // above line 1 for VS Code to let you scroll into, so the top edge (going
  // to the PREVIOUS tab) relies on triggerDelayMs alone.
  "continuousScroll.edgeBufferLines": 0
}
```

### Tuning it to feel right

- Want it forgiving but still eventually trigger on a lingering scroll?
  Leave `edgeBufferLines` at `0` and just raise `triggerDelayMs` (try 500-800).
- Want it to require a genuinely deliberate "keep scrolling past the end"
  gesture on the bottom edge specifically? Turn on `editor.scrollBeyondLastLine`
  and set `edgeBufferLines` to something like `5-15`. The extension will
  offer to flip that setting on for you the first time it notices it's off.
- Want the old snap-instantly-on-touch behavior back? Set
  `triggerDelayMs` to `0`.

There's also a status bar item (bottom right) you can click to toggle it on
and off quickly, and a command palette entry:
**"Continuous Scroll: Toggle On/Off"**.

## Known limitations

- Only affects tabs within the *same* editor group / tab bar. If you have a
  split editor, it won't jump across the split — that's intentional so it
  doesn't fight with side-by-side comparisons.
- Very short files that fit entirely in the viewport won't trigger a jump on
  open, only once you've actually scrolled.
