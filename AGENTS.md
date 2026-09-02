# Agent Notes: CodexBar Cinnamon Applet

Single-file applet (`applet.js`) plus `settings-schema.json` and
`stylesheet.css`. No build step, no tests. `node --check applet.js` only proves
the file parses. The runtime is GJS, not Node, so verify real behavior in a live
Cinnamon session.

## Verify against the live applet

Cinnamon's `Eval` DBus method runs JS inside the running shell:

```sh
# reload just this applet
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon \
  org.Cinnamon.Eval string:'imports.ui.extension.reloadExtension("codexbar@local", imports.ui.extension.Type.APPLET); "ok"'

# inspect it
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon \
  org.Cinnamon.Eval string:'
    let a = imports.ui.appletManager.definitions.find(x => x.uuid === "codexbar@local").applet;
    let b = a.actor.get_allocation_box();
    "w=" + (b.x2-b.x1) + " percent=" + a.panelPercent + " mode=" + a.panelGaugeMode;'
```

Allocation boxes are **physical** pixels; on a 2x display every CSS length reads
back doubled. `set_size()` takes raw pixels and is *not* scaled, hence the
explicit `PANEL_GAUGE_SCALE` constant.

Live config: `~/.config/cinnamon/spices/codexbar@local/<instance>.json`.

## Cinnamon/GJS gotchas

- **`setOptions()` doesn't make a combobox value safe.** On any
  `settings-schema.json` change (tracked by md5), Cinnamon's `_doUpgrade` ->
  `_checkSanity` validates combobox values against the **schema's** own
  `options`, never the ones the applet set at runtime; anything missing is
  silently reset to `default`. A dynamically-populated combobox must also list
  its possible values in the schema.
- `setOptions` compares with `!=` on objects, so a fresh literal always looks
  changed, and every `setValue`/`setOptions` call rewrites the settings file
  synchronously.
- No file monitor on the applet side. Dialog edits arrive over DBus
  (`updateSetting` -> `remoteUpdate`). Bound properties are live getters onto
  `settingsData`, so assignment persists immediately.
- **`hide_applet_icon()` doesn't hide the icon bin.** It only sets `child =
  null`; the bin stays visible. `_layoutBin` isn't hidden by default either.
- `.applet-box` charges `spacing: 5px` between every **visible** child
  regardless of width, so hide both `this._applet_icon_box.hide()` and
  `this.set_applet_label("")` to avoid dead gaps.
- **Use `set_applet_label("")`, not `_layoutBin.hide()`, and don't parent the
  gauge into `_layoutBin`.** `setOrientation()` re-runs
  `set_applet_label(this._applet_label.get_text())`; a label whose text was
  never assigned reads back as `null`, fails Cinnamon's `text == ""` check, and
  takes the *show* branch. Assigning `""` once fixes it. Hiding the label hides
  `_layoutBin`'s children too, so add the gauge with `actor.add(..., {x_fill:
  false, y_fill: false})` instead: `add_actor()`'s default fill stretches a
  `St.DrawingArea` to full panel height, and the gauge derives its radius/centre
  from that allocation.

## CodexBar CLI gotchas

- **Nonzero exit doesn't mean the payload is useless.** `codexbar usage` exits
  with the failing provider's error `code` (rate-limited Claude OAuth gives `3`)
  while still printing a record per provider, healthy ones included. Treat the
  parsed JSON as authoritative and let each record's own `error` field describe
  that provider; only fall back to a run-level error when the output is empty,
  unparseable, or the exit code has no record to explain it.
- **On Linux, `oauth` is the only fast Claude source.** `--source web` is
  macOS-only (`selected source requires web support and is only supported on
  macOS`), so `auto` falls through to the Claude CLI. Measured: `oauth` ~0.33s,
  `auto`/`cli` ~16.9s, `web` fails in 10ms. So `auto` is ~50x slower and leaves
  the gauge in `loading` for the whole fetch. Anthropic rate-limits `oauth`
  intermittently regardless of polling interval. Degrade gracefully per provider
  rather than switching source; the next tick recovers on its own.
