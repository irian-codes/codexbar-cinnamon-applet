# Agent Notes: CodexBar Cinnamon Applet

Single-file applet (`applet.js`) plus `settings-schema.json` and
`stylesheet.css`. No build step, no tests. `node --check applet.js` is the only
cheap gate, and it only proves the file parses. The runtime is GJS, not Node, so
anything past syntax has to be checked in a live Cinnamon session.

## Verify against the live applet, not by reading

Cinnamon exposes an `Eval` method that runs JS inside the running shell. Use it
to reload the applet and measure real geometry instead of reasoning about layout:

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

Allocation boxes are **physical** pixels, relative to the parent, so on a 2x
display every CSS length reads back doubled. `set_size()` takes raw pixels and is
*not* scaled, which is why the gauge constants carry an explicit
`PANEL_GAUGE_SCALE`.

Live config: `~/.config/cinnamon/spices/codexbar@local/<instance>.json`.

## Settings gotchas

- **`setOptions()` does not make a combobox value safe.** On any
  `settings-schema.json` change (tracked by md5) Cinnamon runs `_doUpgrade` ->
  `_checkSanity`, which validates combobox values against the **schema's** own
  `options` and never against the ones the applet wrote at runtime. Anything
  missing there is silently discarded back to `default`. So a
  dynamically-populated combobox must *also* list its possible values in the
  schema. This is what reset `gauge-provider` on every schema edit.
- **Every `setValue`/`setOptions` call rewrites the whole settings file
  synchronously**, and `setOptions` compares with `!=` on objects, so a fresh
  literal always looks changed. Guard writes behind a comparison the way
  `_syncProviderSettings` does; otherwise a refresh that writes settings thrashes
  the file and can loop back through the bound change callback.
- The applet side has **no file monitor**. Dialog edits arrive over DBus
  (`updateSetting` -> `remoteUpdate`). Bound properties are live getters onto
  `settingsData`, so assigning one persists immediately.
- `provider` selects what gets **fetched**. `gauge-provider` selects what the
  panel gauge **tracks**. Independent settings; confusing them looks exactly like
  the gauge ignoring the provider setting.

## Panel layout gotchas

- **`hide_applet_icon()` does not hide the icon bin.** It only sets
  `child = null`; the bin stays visible. `_layoutBin` (the label) is not hidden
  by default either.
- `.applet-box` carries `spacing: 5px`, charged between every **visible** child
  regardless of its width. Each empty-but-visible bin therefore costs a full gap
  of dead space and pushes real content off the applet's centre. Hide both:
  `this._applet_icon_box.hide()` and `this.set_applet_label("")`.
- **Use `set_applet_label("")`, not `_layoutBin.hide()`.** `setOrientation()`
  re-runs `set_applet_label(this._applet_label.get_text())`, and a label whose
  text was never assigned reads back as `null`, which fails Cinnamon's
  `text == ""` check and takes the *show* branch. Assigning `""` once makes every
  later call hide the bin by itself.
- Keep the gauge's horizontal margins symmetric (currently none). `.applet-box`
  already pads 5px either side.
- Add the gauge with `actor.add(..., {x_fill: false, y_fill: false})`, not
  `add_actor()`: the default fill stretches a `St.DrawingArea` to the full panel
  height, and the gauge derives its radius and centre from that allocation. Do
  not parent it into `_layoutBin` either, since hiding the label takes the bin's
  children with it.

## CodexBar CLI gotchas

- **A nonzero exit does not mean the payload is useless.** `codexbar usage` exits
  with the failing provider's error `code` (a rate-limited Claude OAuth endpoint
  gives `3`) while still printing a record per provider, the healthy ones
  included. Treat the parsed JSON as authoritative and let each record's own
  `error` field describe that provider; only fall back to a run-level error when
  the output is empty, unparseable, or the exit code has no record to explain it.
- **On Linux, `oauth` is the only fast Claude source.** `--source web` is macOS
  only (`selected source requires web support and is only supported on macOS`),
  so with no cookie path available `auto` falls straight through to the Claude
  CLI. Measured on this machine: `oauth` ~0.33s, `auto` ~16.9s, `cli` ~16.9s,
  `web` fails in 10ms. `auto` is therefore ~50x slower, not safer, and it leaves
  the panel gauge in `loading` for the whole fetch after every reload or login.
- `oauth` is fast but Anthropic rate limits it intermittently, independent of
  polling interval. That is a reason to degrade gracefully per provider, not a
  reason to switch source: the next tick recovers on its own.
- Record-level errors must not be copied into `lastError`. That field is the
  run-level banner, and `_buildBody` renders it *alongside* the active record's
  `model.error`, so copying one into the other both duplicated the message and
  left a stale banner on healthy tabs after `_setActiveProvider` (which rebuilds
  the body without going through `_applyRecords`).
