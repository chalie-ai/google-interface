/**
 * Settings panel module for the Google interface daemon.
 *
 * Provides three exports:
 *  - {@link loadSettings}       — reads settings from disk with defaults
 *  - {@link saveSettings}       — persists settings to disk
 *  - {@link renderSettingsPanel} — renders an HTML fragment for the settings UI
 *
 * The settings file is stored at `{dataDir}/settings.json` where `dataDir` is
 * resolved by {@link getDataDir} from `lib/data-dir.ts`.
 *
 * @module
 */

import { getDataDir } from "../lib/data-dir.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * User-configurable sync preferences for the Google interface daemon.
 *
 * All four fields are required in the stored JSON; {@link loadSettings} fills
 * in defaults for any field that is absent or corrupted on disk.
 */
export interface Settings {
  /** Whether automatic email polling/signal-emission is active. */
  emailSyncEnabled: boolean;
  /** How often (in minutes) to check for new emails. Valid values: 5, 15, 30, 60. */
  emailSyncInterval: number;
  /** Whether automatic calendar polling/signal-emission is active. */
  calendarSyncEnabled: boolean;
  /** How often (in minutes) to check for upcoming calendar events. Valid values: 1, 5, 15, 30. */
  calendarSyncInterval: number;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/**
 * Baseline settings applied when the settings file is absent or partially
 * corrupted.  Individual missing fields are filled in from this object; the
 * file is not required to be completely valid for a merge to succeed.
 */
const DEFAULTS: Settings = {
  emailSyncEnabled: true,
  emailSyncInterval: 15,
  calendarSyncEnabled: true,
  calendarSyncInterval: 5,
};

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the settings JSON file.
 *
 * @returns {string} Path derived from `getDataDir()`.
 */
function settingsPath(): string {
  return `${getDataDir()}/settings.json`;
}

/**
 * Load settings from `{dataDir}/settings.json`, merging with defaults.
 *
 * - If the file does not exist the default {@link Settings} object is returned.
 * - If the file exists but contains invalid JSON (or is partially corrupted),
 *   the successfully-parsed fields are retained and missing/invalid fields are
 *   filled in from {@link DEFAULTS}.
 * - Field-level type coercion is performed so that a settings file that was
 *   hand-edited with string values for numeric fields still works.
 *
 * @returns {Promise<Settings>} A fully-populated settings object.
 *
 * @example
 * const settings = await loadSettings();
 * console.log(settings.emailSyncInterval); // 15 (if not customised)
 */
export async function loadSettings(): Promise<Settings> {
  let raw: Record<string, unknown> = {};

  try {
    const text = await Deno.readTextFile(settingsPath());
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // File absent, unreadable, or malformed JSON — fall through to defaults.
  }

  return {
    emailSyncEnabled:
      typeof raw.emailSyncEnabled === "boolean"
        ? raw.emailSyncEnabled
        : DEFAULTS.emailSyncEnabled,
    emailSyncInterval:
      typeof raw.emailSyncInterval === "number" && Number.isFinite(raw.emailSyncInterval)
        ? raw.emailSyncInterval
        : DEFAULTS.emailSyncInterval,
    calendarSyncEnabled:
      typeof raw.calendarSyncEnabled === "boolean"
        ? raw.calendarSyncEnabled
        : DEFAULTS.calendarSyncEnabled,
    calendarSyncInterval:
      typeof raw.calendarSyncInterval === "number" && Number.isFinite(raw.calendarSyncInterval)
        ? raw.calendarSyncInterval
        : DEFAULTS.calendarSyncInterval,
  };
}

/**
 * Persist settings to `{dataDir}/settings.json`.
 *
 * The file is written atomically via Deno's `writeTextFile`.  The parent
 * directory must already exist (the daemon entry point is responsible for
 * calling `ensureDir(getDataDir())` at startup).
 *
 * @param {Settings} settings - The settings object to serialise and write.
 * @returns {Promise<void>}
 *
 * @example
 * await saveSettings({ ...current, emailSyncInterval: 30 });
 */
export async function saveSettings(settings: Settings): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  await Deno.writeTextFile(settingsPath(), json);
}

// ---------------------------------------------------------------------------
// UI renderer
// ---------------------------------------------------------------------------

/**
 * Render an HTML fragment containing the settings form.
 *
 * The fragment is intended to be embedded inside a full HTML page produced by
 * `ui/main.ts`.  It does **not** include `<html>`, `<head>`, or `<body>` tags.
 *
 * ### Behaviour
 * - All form controls are pre-populated with the current `settings` values.
 * - "Save settings" calls `window.chalie.execute('update_settings', { ... })`
 *   with the current form values and shows a toast on success/failure.
 * - "Disconnect Account" calls `window.chalie.execute('_setup_disconnect', {})`
 *   then reloads the page so the setup wizard is displayed.
 * - A note informs the user that interval changes take effect within a minute.
 *
 * @param {Settings} settings - Current settings used to pre-populate controls.
 * @param {string | null} connectedEmail - The Google account email address, or
 *   `null` if no account is connected (renders a "Not connected" placeholder).
 * @returns {string} An HTML fragment string.
 *
 * @example
 * const settings = await loadSettings();
 * const email = await getConnectedEmail();
 * const html = renderSettingsPanel(settings, email);
 */
export function renderSettingsPanel(settings: Settings, connectedEmail: string | null): string {
  /**
   * Build a `<select>` element for numeric interval options.
   *
   * @param {string} id - The element id / name attribute.
   * @param {number[]} options - Available option values (in minutes).
   * @param {number} current - The currently selected value.
   * @returns {string} HTML string for the select element.
   */
  function intervalSelect(id: string, options: number[], current: number): string {
    const optionTags = options
      .map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${v} min</option>`)
      .join("");
    return `<select id="${id}" name="${id}" class="form-select form-select-sm d-inline-block w-auto ms-2">${optionTags}</select>`;
  }

  const emailIntervalSelect = intervalSelect(
    "emailSyncInterval",
    [5, 15, 30, 60],
    settings.emailSyncInterval,
  );

  const calendarIntervalSelect = intervalSelect(
    "calendarSyncInterval",
    [1, 5, 15, 30],
    settings.calendarSyncInterval,
  );

  const emailChecked = settings.emailSyncEnabled ? " checked" : "";
  const calendarChecked = settings.calendarSyncEnabled ? " checked" : "";

  const accountDisplay = connectedEmail
    ? `<span class="text-success fw-semibold">${escapeHtml(connectedEmail)}</span>`
    : `<span class="text-muted fst-italic">Not connected</span>`;

  return `
<div id="settings-panel" class="card shadow-sm mb-4">
  <div class="card-header d-flex align-items-center gap-2">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor"
         class="bi bi-gear-fill" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987
               1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1
               .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413
               1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705
               1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397
               0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464
               1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
    </svg>
    <strong>Settings</strong>
  </div>

  <div class="card-body">

    <!-- Connected Account -->
    <section class="mb-4">
      <h6 class="text-uppercase text-muted small fw-semibold mb-2">Connected Account</h6>
      <div class="d-flex align-items-center gap-3 flex-wrap">
        <div>${accountDisplay}</div>
        <button
          type="button"
          class="btn btn-sm btn-outline-danger"
          id="disconnect-btn"
          onclick="handleDisconnect()"
          ${connectedEmail ? "" : "disabled"}>
          Disconnect Account
        </button>
      </div>
    </section>

    <hr class="my-3" />

    <!-- Email Sync -->
    <section class="mb-4">
      <h6 class="text-uppercase text-muted small fw-semibold mb-3">Email Sync</h6>

      <div class="form-check form-switch mb-2">
        <input
          class="form-check-input"
          type="checkbox"
          role="switch"
          id="emailSyncEnabled"
          name="emailSyncEnabled"
          ${emailChecked} />
        <label class="form-check-label" for="emailSyncEnabled">
          Enable email notifications
        </label>
      </div>

      <div class="mt-2">
        <label class="form-label mb-0">
          Check for new emails every
          ${emailIntervalSelect}
        </label>
      </div>
    </section>

    <hr class="my-3" />

    <!-- Calendar Sync -->
    <section class="mb-4">
      <h6 class="text-uppercase text-muted small fw-semibold mb-3">Calendar Sync</h6>

      <div class="form-check form-switch mb-2">
        <input
          class="form-check-input"
          type="checkbox"
          role="switch"
          id="calendarSyncEnabled"
          name="calendarSyncEnabled"
          ${calendarChecked} />
        <label class="form-check-label" for="calendarSyncEnabled">
          Enable calendar reminders
        </label>
      </div>

      <div class="mt-2">
        <label class="form-label mb-0">
          Check for upcoming events every
          ${calendarIntervalSelect}
        </label>
      </div>
    </section>

    <hr class="my-3" />

    <!-- Save button + note -->
    <div class="d-flex align-items-center gap-3 flex-wrap">
      <button type="button" class="btn btn-primary" id="save-settings-btn" onclick="saveSettings()">
        Save Settings
      </button>
      <span class="text-muted small">
        &#8505;&#xFE0F; Changes take effect within a minute.
      </span>
    </div>

    <!-- Toast notification -->
    <div id="settings-toast" class="mt-3" style="display:none;">
      <div id="settings-toast-inner" class="alert mb-0" role="alert"></div>
    </div>

  </div><!-- /.card-body -->
</div><!-- /#settings-panel -->

<script>
(function () {
  /**
   * Collect the current form values from the settings panel controls.
   *
   * @returns {{ emailSyncEnabled: boolean, emailSyncInterval: number,
   *             calendarSyncEnabled: boolean, calendarSyncInterval: number }}
   */
  function collectFormValues() {
    return {
      emailSyncEnabled: document.getElementById("emailSyncEnabled").checked,
      emailSyncInterval: parseInt(
        document.getElementById("emailSyncInterval").value,
        10
      ),
      calendarSyncEnabled: document.getElementById("calendarSyncEnabled").checked,
      calendarSyncInterval: parseInt(
        document.getElementById("calendarSyncInterval").value,
        10
      ),
    };
  }

  /**
   * Show a dismissible toast message inside the settings panel.
   *
   * @param {string} message - The text to display.
   * @param {"success"|"danger"|"warning"} type - Bootstrap alert variant.
   */
  function showToast(message, type) {
    var toast = document.getElementById("settings-toast");
    var inner = document.getElementById("settings-toast-inner");
    inner.textContent = message;
    inner.className = "alert alert-" + type + " mb-0";
    toast.style.display = "block";
    setTimeout(function () {
      toast.style.display = "none";
    }, 4000);
  }

  /**
   * Save the current settings form values via the Chalie execute bridge.
   * Shows a success toast on resolution or an error toast on rejection.
   *
   * Attached to the global scope so the onclick handler can reach it.
   */
  window.saveSettings = async function saveSettings() {
    var btn = document.getElementById("save-settings-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await window.chalie.execute("update_settings", collectFormValues());
      showToast("Settings saved.", "success");
    } catch (err) {
      showToast(
        "Couldn\u2019t save settings: " + (err && err.message ? err.message : String(err)),
        "danger"
      );
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Settings";
    }
  };

  /**
   * Disconnect the current Google account by calling the internal disconnect
   * capability, then reload the page so the setup wizard is shown.
   *
   * Attached to the global scope so the onclick handler can reach it.
   */
  window.handleDisconnect = async function handleDisconnect() {
    if (!confirm("Disconnect your Google account? Sync will stop until you reconnect.")) return;
    var btn = document.getElementById("disconnect-btn");
    btn.disabled = true;
    btn.textContent = "Disconnecting…";
    try {
      await window.chalie.execute("_setup_disconnect", {});
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Disconnect Account";
      showToast(
        "Couldn\u2019t disconnect: " + (err && err.message ? err.message : String(err)),
        "danger"
      );
    }
  };
})();
</script>
`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape special HTML characters in a string so it is safe for insertion into
 * HTML attribute values and text content.
 *
 * Characters escaped: `&`, `<`, `>`, `"`, `'`.
 *
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
