/**
 * Main dashboard view for the Google interface daemon (block protocol).
 *
 * Renders the Gmail + Calendar tabbed dashboard with search forms,
 * result containers, and a settings panel — all as block arrays.
 *
 * @module
 */

import type { Block } from "../../_sdk/blocks.ts";
import type { Settings } from "./settings.ts";
import {
  tabs, section, header, text, form, input, actions, button,
  container, loading, divider, columns, badge,
} from "../../_sdk/blocks.ts";
import { renderSettingsPanel } from "./settings.ts";

/** Suggested Gmail prompts shown as helpful hints. */
const GMAIL_PROMPTS = [
  "Show me my unread emails",
  "Search for emails from [name or address]",
  "Show me emails about [topic]",
  "Show me the last 10 emails in my inbox",
  "Find emails that have attachments",
  "Draft a reply to the latest email from [name]",
];

/**
 * Render the main dashboard as blocks.
 *
 * @param connectedEmail - The authenticated Google account email.
 * @param settings - Current settings for the settings panel.
 * @returns Block array for the main dashboard UI.
 */
export function renderMainView(
  connectedEmail: string | null,
  settings: Settings,
): Block[] {
  const emailLabel = connectedEmail || "Google Account";

  return [
    // Header with connection status
    columns(
      { width: "1fr", blocks: [header("Google", 2)] },
      { width: "auto", blocks: [badge(emailLabel, "success")] },
    ),

    divider(),

    // Main tabbed content
    tabs(
      {
        label: "Gmail",
        blocks: gmailTab(),
      },
      {
        label: "Calendar",
        blocks: calendarTab(),
      },
      {
        label: "Settings",
        blocks: renderSettingsPanel(settings, connectedEmail),
      },
    ),
  ];
}

/** Gmail tab content — search form + results + suggested prompts. */
function gmailTab(): Block[] {
  return [
    section([
      form("gmail-search", [
        input("query", { placeholder: "Search emails (e.g. from:alice subject:invoice)" }),
        actions(
          button("Search", {
            execute: "gmail_search",
            collect: "gmail-search",
            target: "gmail-results",
          }),
        ),
      ]),
      container("gmail-results", [
        text("Search for emails above or ask Chalie to help.", "plain"),
      ]),
    ]),

    divider(),

    // Suggested prompts
    section([
      text("Try asking Chalie:", "plain"),
      ...GMAIL_PROMPTS.map(p => text(`• ${p}`, "plain")),
    ], "Suggested Prompts", true),
  ];
}

/** Calendar tab content — events loaded automatically via polling. */
function calendarTab(): Block[] {
  return [
    section([
      form("calendar-query", [
        input("days", { placeholder: "Number of days to show (default: 7)", value: "7" }),
        actions(
          button("Load Events", {
            execute: "calendar_events",
            collect: "calendar-query",
            target: "calendar-results",
          }),
        ),
      ]),
      container("calendar-results", [
        loading("Loading upcoming events..."),
      ], { capability: "calendar_events", interval: 60000, params: { days: 7 } }),
    ]),
  ];
}
