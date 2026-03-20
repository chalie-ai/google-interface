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
// UI renderer (block protocol)
// ---------------------------------------------------------------------------

import type { Block } from "../../_sdk/blocks.ts";
import {
  section, header, text, form, toggle, select, actions, button, divider, alert,
} from "../../_sdk/blocks.ts";

/**
 * Render the settings panel as blocks.
 *
 * @param settings - Current settings used to pre-populate controls.
 * @param connectedEmail - The Google account email, or null if not connected.
 * @returns Block array for the settings UI.
 */
export function renderSettingsPanel(settings: Settings, connectedEmail: string | null): Block[] {
  return [
    section([
      header("Settings", 2),

      // Connected Account
      section([
        text(connectedEmail ? `Connected as **${connectedEmail}**` : "Not connected", "markdown"),
        actions(
          button("Disconnect Account", { execute: "_setup_disconnect", style: "danger" }),
        ),
      ], "Connected Account"),

      divider(),

      // Email Sync
      form("settings-form", [
        section([
          toggle("emailSyncEnabled", "Enable email notifications", settings.emailSyncEnabled),
          select(
            "emailSyncInterval",
            [
              { label: "5 min", value: "5" },
              { label: "15 min", value: "15" },
              { label: "30 min", value: "30" },
              { label: "60 min", value: "60" },
            ],
            String(settings.emailSyncInterval),
          ),
        ], "Email Sync"),

        divider(),

        // Calendar Sync
        section([
          toggle("calendarSyncEnabled", "Enable calendar reminders", settings.calendarSyncEnabled),
          select(
            "calendarSyncInterval",
            [
              { label: "1 min", value: "1" },
              { label: "5 min", value: "5" },
              { label: "15 min", value: "15" },
              { label: "30 min", value: "30" },
            ],
            String(settings.calendarSyncInterval),
          ),
        ], "Calendar Sync"),

        divider(),

        actions(
          button("Save Settings", { execute: "update_settings", collect: "settings-form" }),
        ),
        alert("Changes take effect within a minute.", "info"),
      ]),
    ]),
  ];
}
