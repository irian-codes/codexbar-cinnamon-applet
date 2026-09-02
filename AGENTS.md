# Agent Notes

- Runtime is Cinnamon GJS. `node --check applet.js` checks syntax only.
- Verify behavior in live Cinnamon. Reload the applet with:
  `dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon org.Cinnamon.Eval string:'imports.ui.extension.reloadExtension("codexbar@local", imports.ui.extension.Type.APPLET); "ok"'`
- Keep dynamic combobox values in `settings-schema.json` options. Guard
  `setValue()` and `setOptions()` because both write synchronously.
- Preserve parsed provider records from nonzero CodexBar exits. Record errors
  describe provider-scoped failures.
