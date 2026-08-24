const Applet = imports.ui.applet;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Util = imports.misc.util;
const AppletManager = imports.ui.appletManager;
const Cairo = imports.cairo;

const DEFAULT_COMMAND = "/opt/apps/codexbar/codexbar";
const DEFAULT_PROVIDER = "codex";
const DEFAULT_REFRESH_SECONDS = 60;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PANEL_GAUGE_WIDTH = 28;
const PANEL_GAUGE_HEIGHT = 16;

class CodexBarApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.appletPath = metadata.path || (AppletManager.appletMeta[metadata.uuid] && AppletManager.appletMeta[metadata.uuid].path) || ".";
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menuManager.addMenu(this.menu);

        this.refreshTimerId = 0;
        this.refreshing = false;
        this.lastUpdated = null;
        this.lastError = null;
        this.records = [];
        this.panelPercent = 0;
        this.panelGaugeMode = "loading";

        this.panelGauge = new St.DrawingArea({ style_class: "codexbar-panel-gauge" });
        this.panelGauge.set_size(PANEL_GAUGE_WIDTH, PANEL_GAUGE_HEIGHT);
        this.panelGauge.connect("repaint", Lang.bind(this, this._drawPanelGauge));
        this._layoutBin.set_child(this.panelGauge);
        this._layoutBin.show();

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("command-path", "commandPath", this._onSettingsChanged);
        this.settings.bind("provider", "provider", this._onSettingsChanged);
        this.settings.bind("refresh-interval", "refreshInterval", this._onSettingsChanged);

        this._setLoadingState();
        this._buildMenu();
        this._refresh();
        this._scheduleRefresh();
    }

    on_applet_clicked() {
        this._buildMenu();
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._clearRefreshTimer();
        this.settings.finalize();
    }

    _onSettingsChanged() {
        this.commandPath = this.commandPath || DEFAULT_COMMAND;
        this.provider = this.provider || DEFAULT_PROVIDER;
        this.refreshInterval = Math.max(15, Number(this.refreshInterval || DEFAULT_REFRESH_SECONDS));
        this._applyIconPreference();
        this._clearRefreshTimer();
        this._refresh();
        this._scheduleRefresh();
    }

    _applyIconPreference() {
        this.hide_applet_icon();
    }

    _setLoadingState() {
        this._applyIconPreference();
        this._setPanelGauge(0, "loading");
        this.set_applet_tooltip("CodexBar: refreshing");
    }

    _setRecords(records) {
        this.records = records || [];
        this.lastUpdated = new Date();

        let model = this._modelFromRecords(this.records);
        this.lastError = model.error;
        this._setPanelGauge(model.gaugePercent, model.error ? "error" : "normal");
        this.set_applet_tooltip(model.tooltip);
        this._buildMenu();
    }

    _setErrorState(message) {
        this.lastUpdated = new Date();
        this.lastError = message || "Unknown CodexBar error";
        this._setPanelGauge(100, "error");
        this.set_applet_tooltip("CodexBar: " + this.lastError);
        this._buildMenu();
    }

    _setPanelGauge(percent, mode) {
        this.panelPercent = Math.max(0, Math.min(100, Number(percent || 0)));
        this.panelGaugeMode = mode || "normal";
        this.panelGauge.queue_repaint();
    }

    _drawPanelGauge(area) {
        let cr = area.get_context();
        let [width, height] = area.get_surface_size();
        let percent = this.panelGaugeMode === "loading" ? 0 : this.panelPercent;
        let ratio = Math.max(0, Math.min(1, percent / 100));
        let cx = width / 2;
        let cy = height - 2.5;
        let radius = Math.min(width / 2 - 3, height - 4);
        let start = Math.PI;
        let end = Math.PI * 2;
        let activeEnd = start + (end - start) * ratio;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(3.2);
        cr.arc(cx, cy, radius, start, end);
        cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.stroke();

        if (this.panelGaugeMode === "error") {
            cr.setSourceRGBA(0.95, 0.22, 0.18, 1);
        } else if (this.panelGaugeMode === "loading") {
            cr.setSourceRGBA(0.45, 0.65, 1, 0.8);
        } else {
            let color = this._usageColor(ratio);
            cr.setSourceRGBA(color[0], color[1], color[2], 1);
        }

        if (ratio > 0 || this.panelGaugeMode !== "normal") {
            cr.arc(cx, cy, radius, start, Math.max(start + 0.04, activeEnd));
            cr.stroke();
        }

        cr.$dispose();
    }

    _usageColor(ratio) {
        if (ratio < 0.65) {
            return [0.29, 0.87, 0.45];
        }
        if (ratio < 0.85) {
            return [1.0, 0.72, 0.18];
        }
        return [0.96, 0.25, 0.20];
    }

    _scheduleRefresh() {
        this._clearRefreshTimer();
        this.refreshTimerId = Mainloop.timeout_add_seconds(this.refreshInterval || DEFAULT_REFRESH_SECONDS, Lang.bind(this, function() {
            this._refresh(false);
            return true;
        }));
    }

    _clearRefreshTimer() {
        if (this.refreshTimerId) {
            Mainloop.source_remove(this.refreshTimerId);
            this.refreshTimerId = 0;
        }
    }

    _refresh(manual) {
        if (this.refreshing) {
            if (manual && this.menu.isOpen) {
                this._buildMenu();
            }
            return;
        }

        this.refreshing = true;
        this.set_applet_tooltip("CodexBar: refreshing");
        if (this.menu.isOpen) {
            this._buildMenu();
        }

        try {
            Util.spawnCommandLineAsyncIO(null, Lang.bind(this, function(stdout, stderr, exitCode) {
                this.refreshing = false;

                let output = stdout || "";
                if (!output.trim() && stderr) {
                    this._setErrorState("CodexBar failed: " + stderr.trim());
                    return;
                }

                try {
                    let parsed = JSON.parse(output || "[]");
                    this._setRecords(Array.isArray(parsed) ? parsed : [parsed]);
                } catch (e) {
                    let suffix = stderr ? " (" + stderr.trim() + ")" : "";
                    this._setErrorState("Could not parse CodexBar JSON: " + e.message + suffix);
                }

                if (manual) {
                    this._scheduleRefresh();
                }
            }), {
                argv: [
                this.commandPath || DEFAULT_COMMAND,
                "usage",
                "--format",
                "json",
                "--provider",
                this.provider || DEFAULT_PROVIDER
                ]
            });
        } catch (e) {
            this.refreshing = false;
            this._setErrorState("Could not run CodexBar: " + e.message);
        }
    }

    _buildMenu() {
        this.menu.removeAll();

        let model = this._modelFromRecords(this.records);
        this._addHeader(model);

        if (model.error) {
            this._addMessage(model.error, "codexbar-error");
        } else if (model.rows.length === 0) {
            this._addMessage("No usage data returned yet.", "codexbar-muted");
        } else {
            for (let i = 0; i < model.rows.length; i++) {
                this._addUsageRow(model.rows[i]);
            }
        }

        if (model.extraUsage) {
            this._addSectionSeparator();
            this._addUsageRow(model.extraUsage);
        }

        if (model.costLines.length > 0) {
            this._addSectionSeparator();
            this._addCostSection(model.costLines);
        }

        this._addSectionSeparator();
        this._addActions();
    }

    _addHeader(model) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-card" });
        let top = new St.BoxLayout({ vertical: false });
        let title = new St.Label({ text: model.title, style_class: "codexbar-title" });
        let right = new St.Label({ text: model.headerRight, style_class: "codexbar-muted" });

        title.x_expand = true;
        top.add_actor(title);
        top.add_actor(right);
        box.add_actor(top);
        box.add_actor(new St.Label({ text: model.subtitle, style_class: "codexbar-subtitle" }));
        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _addUsageRow(row) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-row" });
        let titleLine = new St.BoxLayout({ vertical: false });
        let title = new St.Label({ text: row.title, style_class: "codexbar-row-title" });
        let reset = new St.Label({ text: row.right || "", style_class: "codexbar-muted" });

        title.x_expand = true;
        titleLine.add_actor(title);
        titleLine.add_actor(reset);
        box.add_actor(titleLine);
        box.add_actor(this._progressBar(row.percent));

        let detailLine = new St.BoxLayout({ vertical: false });
        let detail = new St.Label({ text: row.detail || "", style_class: "codexbar-detail" });
        detail.x_expand = true;
        detailLine.add_actor(detail);
        if (row.trailing) {
            detailLine.add_actor(new St.Label({ text: row.trailing, style_class: "codexbar-muted" }));
        }
        box.add_actor(detailLine);

        if (row.note) {
            let note = new St.Label({ text: row.note, style_class: "codexbar-muted" });
            note.clutter_text.line_wrap = true;
            box.add_actor(note);
        }

        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _progressBar(percent) {
        let numericPercent = Number(percent || 0);
        let clamped = Math.max(0, Math.min(100, numericPercent));
        if (Math.round(clamped) === 100) {
            clamped = 100;
        }

        let track = new St.BoxLayout({ style_class: "codexbar-progress-track" });
        let fill = new St.Bin({ style_class: "codexbar-progress-fill" });
        let updateFillWidth = function () {
            let trackWidth = track.get_width();
            let fillWidth = Math.round((trackWidth * clamped) / 100);

            fill.set_width(clamped > 0 ? Math.max(3, fillWidth) : 0);
        };

        track.x_expand = true;
        track.add_actor(fill);
        track.connect("notify::allocation", updateFillWidth);
        return track;
    }

    _addCostSection(lines) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: "codexbar-popup-item" });
        let box = new St.BoxLayout({ vertical: true, style_class: "codexbar-row" });
        box.add_actor(new St.Label({ text: "Cost", style_class: "codexbar-row-title" }));

        for (let i = 0; i < lines.length; i++) {
            box.add_actor(new St.Label({ text: lines[i], style_class: "codexbar-detail" }));
        }

        item.addActor(box, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _addActions() {
        let refreshItem = new PopupMenu.PopupIconMenuItem("Refresh now", "view-refresh", St.IconType.SYMBOLIC);
        refreshItem.connect("activate", Lang.bind(this, this._onRefreshClicked));
        this.menu.addMenuItem(refreshItem);

        this._addMessage("Updated: " + this._formatUpdated(this.lastUpdated), "codexbar-muted");
    }

    _onRefreshClicked() {
        this._refresh(true);
    }

    _addMessage(text, styleClass) {
        let item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.label.add_style_class_name(styleClass);
        item.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(item);
    }

    _addSectionSeparator() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _modelFromRecords(records) {
        let record = this._firstRecord(records);
        let provider = record && record.provider ? this._titleCase(record.provider) : "Codex";
        let source = record && record.source ? record.source : "auto";

        if (!record) {
            return {
                title: "Codex",
                subtitle: "Waiting for data",
                headerRight: "",
                gaugePercent: 0,
                tooltip: "CodexBar: waiting for data",
                error: null,
                rows: [],
                extraUsage: null,
                costLines: []
            };
        }

        if (record.error) {
            let message = this._errorMessage(record.error);
            return {
                title: provider,
                subtitle: source,
                headerRight: "!",
                gaugePercent: 100,
                tooltip: "CodexBar: " + message,
                error: message,
                rows: [],
                extraUsage: null,
                costLines: []
            };
        }

        let gaugePercent = this._gaugeLimitPercent(record);
        let rows = this._usageRows(record);
        let extraUsage = this._extraUsage(record);
        let costLines = this._costLines(record);

        return {
            title: provider,
            subtitle: this.refreshing ? "Refreshing..." : "Updated " + this._relativeUpdated(this.lastUpdated),
            headerRight: this.refreshing ? "" : source,
            gaugePercent: gaugePercent,
            tooltip: this._tooltip(provider, rows, extraUsage),
            error: null,
            rows: rows,
            extraUsage: extraUsage,
            costLines: costLines
        };
    }

    _usageRows(record) {
        let rows = [];
        let primary = this._limitWindow(record, "primary");
        let secondary = this._limitWindow(record, "secondary");

        if (primary) {
            rows.push(this._limitRow("Session", primary));
        }

        if (secondary) {
            rows.push(this._limitRow("Weekly", secondary));
        }

        let windows = this._getPath(record, ["usage", "extraRateWindows"]) || [];
        for (let i = 0; i < windows.length; i++) {
            let title = windows[i].title || "Usage";
            let lower = title.toLowerCase();
            if (lower.indexOf("sonnet") >= 0) {
                rows.push(this._paceRow("Sonnet", windows[i]));
            }
        }

        let reviewRemaining = this._deepFind(record, "codeReviewRemaining");
        if (reviewRemaining !== null && reviewRemaining !== undefined) {
            rows.push({
                title: "Code review",
                percent: 0,
                detail: this._displayValue(reviewRemaining) + " remaining",
                right: "",
                note: ""
            });
        }

        return rows;
    }

    _gaugeLimitPercent(record) {
        let primary = this._limitWindow(record, "primary");
        let percent = primary ? this._firstNumber(primary, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]) : null;
        if (percent !== null) {
            return percent;
        }

        let secondary = this._limitWindow(record, "secondary");
        percent = secondary ? this._firstNumber(secondary, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]) : null;
        return percent === null ? 0 : percent;
    }

    _limitWindow(record, name) {
        let paths = [
            ["usage", name],
            ["usage", "limits", name],
            ["usage", "rateLimits", name],
            ["usage", "rate_limits", name],
            ["limits", name],
            ["rateLimits", name],
            ["rate_limits", name],
            [name]
        ];

        for (let i = 0; i < paths.length; i++) {
            let value = this._getPath(record, paths[i]);
            if (value) {
                return value;
            }
        }

        return null;
    }

    _limitRow(title, value) {
        let percent = this._firstNumber(value, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]);
        let reset = this._firstValue(value, ["resetsAt", "resetAt", "reset_at"]);
        let right = this._resetLabel(value, reset);

        return {
            title: title,
            percent: percent || 0,
            detail: this._percentText(percent),
            right: right,
            note: ""
        };
    }

    _paceRow(title, value) {
        let percent = this._firstNumber(value, ["usedPercent", "percentUsed", "usagePercent", "used_percent"]);
        let reset = this._firstValue(value, ["resetsAt", "resetAt", "reset_at"]);
        let delta = this._firstNumber(value, ["deltaPercent", "delta_percent"]);
        let stage = this._firstValue(value, ["stage"]);
        let summary = this._firstValue(value, ["summary"]);
        let detail = this._percentText(percent);

        return {
            title: title,
            percent: percent || 0,
            detail: detail,
            right: this._resetLabel(value, reset),
            note: summary || this._paceNote(stage, delta)
        };
    }

    _extraUsage(record) {
        let credits = this._getPath(record, ["credits"]);
        if (!credits) {
            return null;
        }

        let remaining = this._firstValue(credits, ["remaining", "available"]);
        let limit = this._firstValue(credits, ["limit", "monthlyLimit", "included"]);
        let used = this._firstValue(credits, ["used"]);
        let percent = this._firstNumber(credits, ["usedPercent", "percentUsed"]);

        if (remaining === null && limit === null && used === null && percent === null) {
            return null;
        }

        let detail = "Remaining: " + this._displayValue(remaining);
        if (used !== null || limit !== null) {
            detail = "This month: " + this._displayValue(used || 0) + " / " + this._displayValue(limit || remaining);
        }

        return {
            title: "Extra usage",
            percent: percent || 0,
            detail: detail,
            trailing: this._percentText(percent || 0),
            right: "",
            note: ""
        };
    }

    _costLines(record) {
        let lines = [];
        let cost = this._getPath(record, ["usage", "cost"]) || this._getPath(record, ["cost"]);

        if (!cost) {
            return lines;
        }

        let today = this._firstValue(cost, ["today", "todayCost"]);
        let last30 = this._firstValue(cost, ["last30Days", "last30DaysCost", "month"]);
        let tokensToday = this._firstValue(cost, ["todayTokens"]);
        let tokens30 = this._firstValue(cost, ["last30DaysTokens"]);

        if (today !== null) {
            lines.push("Today: " + this._displayMoney(today) + (tokensToday !== null ? " · " + this._displayValue(tokensToday) + " tokens" : ""));
        }

        if (last30 !== null) {
            lines.push("Last 30 days: " + this._displayMoney(last30) + (tokens30 !== null ? " · " + this._displayValue(tokens30) + " tokens" : ""));
        }

        return lines;
    }

    _firstRecord(records) {
        if (!records || records.length === 0) {
            return null;
        }

        for (let i = 0; i < records.length; i++) {
            if (records[i] && !records[i].error) {
                return records[i];
            }
        }

        return records[0];
    }

    _firstValue(object, keys) {
        if (!object) {
            return null;
        }

        for (let i = 0; i < keys.length; i++) {
            if (Object.prototype.hasOwnProperty.call(object, keys[i]) && object[keys[i]] !== null && object[keys[i]] !== undefined) {
                return object[keys[i]];
            }
        }

        return null;
    }

    _firstNumber(object, keys) {
        let value = this._firstValue(object, keys);
        if (value === null) {
            return null;
        }

        let numberValue = Number(value);
        return isNaN(numberValue) ? null : numberValue;
    }

    _getPath(object, path) {
        let cursor = object;
        for (let i = 0; i < path.length; i++) {
            if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, path[i])) {
                return null;
            }
            cursor = cursor[path[i]];
        }

        return cursor;
    }

    _deepFind(value, key) {
        if (!value || typeof value !== "object") {
            return null;
        }

        if (Object.prototype.hasOwnProperty.call(value, key)) {
            return value[key];
        }

        let keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            let found = this._deepFind(value[keys[i]], key);
            if (found !== null && found !== undefined) {
                return found;
            }
        }

        return null;
    }

    _tooltip(provider, rows, extraUsage) {
        let parts = [provider];
        for (let i = 0; i < rows.length; i++) {
            parts.push(rows[i].title + ": " + rows[i].detail);
        }
        if (extraUsage) {
            parts.push(extraUsage.title + ": " + extraUsage.detail);
        }
        return parts.join("\n");
    }

    _errorMessage(error) {
        if (!error) {
            return "Unknown error";
        }
        if (typeof error === "string") {
            return error;
        }
        return error.message || JSON.stringify(error);
    }

    _paceNote(stage, delta) {
        let parts = [];
        if (stage) {
            parts.push("Pace: " + this._titleCase(stage));
        }
        if (delta !== null && delta !== undefined) {
            parts.push((delta > 0 ? "+" : "") + Math.round(delta) + "%");
        }
        return parts.join(" · ");
    }

    _percentText(percent) {
        return Math.round(Number(percent || 0)) + "% used";
    }

    _displayValue(value) {
        if (value === null || value === undefined || value === "") {
            return "0";
        }
        if (typeof value === "number") {
            return value >= 1000 ? Math.round(value).toLocaleString() : String(value);
        }
        return String(value);
    }

    _displayMoney(value) {
        let numberValue = Number(value);
        if (isNaN(numberValue)) {
            return String(value);
        }
        return "$ " + numberValue.toFixed(2);
    }

    _titleCase(value) {
        let text = String(value || "");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }

    _pad2(number) {
        return (number < 10 ? "0" : "") + number;
    }

    // Always 24h. Formatted by hand rather than through toLocaleTimeString so the
    // result does not depend on LC_TIME (en_US would render 12h here).
    _clock24(date) {
        return this._pad2(date.getHours()) + ":" + this._pad2(date.getMinutes());
    }

    _sameDay(a, b) {
        return a.getFullYear() === b.getFullYear()
            && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate();
    }

    _formatResetAt(value) {
        let date = new Date(value);
        if (isNaN(date.getTime())) {
            return null;
        }

        let clock = this._clock24(date);
        if (this._sameDay(date, new Date())) {
            return clock;
        }

        return MONTH_NAMES[date.getMonth()] + " " + date.getDate() + ", " + clock;
    }

    // CodexBar's resetDescription is unreliable: for Claude it arrives unspaced and
    // already prefixed ("Resets9:10pm(Europe/Madrid)"). Prefer the ISO timestamp and
    // only fall back to the description, de-duplicating its prefix when we do.
    _resetLabel(value, reset) {
        let absolute = reset ? this._formatResetAt(reset) : null;
        if (absolute) {
            return "Resets " + absolute;
        }

        let description = this._firstValue(value, ["resetDescription"]);
        if (description) {
            let text = String(description).trim();
            return /^resets/i.test(text) ? text : "Resets " + text;
        }

        return reset ? "Resets " + this._relativeTime(reset) : "";
    }

    _relativeUpdated(date) {
        if (!date) {
            return "soon";
        }

        let seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 45) {
            return "just now";
        }
        if (seconds < 3600) {
            return Math.floor(seconds / 60) + "m ago";
        }
        return this._clock24(date);
    }

    _formatUpdated(date) {
        return date ? this._clock24(date) : "never";
    }

    _relativeTime(value) {
        let date = new Date(value);
        if (isNaN(date.getTime())) {
            return String(value);
        }

        let minutes = Math.max(0, Math.floor((date.getTime() - Date.now()) / 60000));
        let days = Math.floor(minutes / 1440);
        let hours = Math.floor((minutes % 1440) / 60);
        let mins = minutes % 60;

        if (days > 0) {
            return "in " + days + "d " + hours + "h";
        }
        if (hours > 0) {
            return "in " + hours + "h " + mins + "m";
        }
        return "in " + mins + "m";
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new CodexBarApplet(metadata, orientation, panelHeight, instanceId);
}
