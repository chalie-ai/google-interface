/**
 * LLM-facing capability definitions for the Chalie Google Interface daemon.
 *
 * This module exports {@link ALL_CAPABILITIES} — the authoritative list of
 * tools advertised to Chalie's ACT loop.  The array contains exactly 12
 * entries covering Gmail and Google Calendar operations plus a settings-update
 * tool.
 *
 * ## Design notes
 *
 * - Capability and Parameter types are defined locally here so that
 *   `capabilities.ts` itself has no SDK import dependency.  The shapes are
 *   structurally compatible with the types expected by `createDaemon()`.
 * - Internal capabilities (prefixed `_`, e.g. `_setup_disconnect`) are
 *   handled inside `executeCommand()` in `daemon.ts` but are intentionally
 *   **not** included here so they never appear in the LLM's tool list.
 * - Array-valued parameters (attendees, etc.) are represented as
 *   comma-separated strings (`type: "string"`) because the SDK's
 *   `Parameter.type` union does not include `"array"`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Local type declarations (structurally compatible with the SDK types)
// ---------------------------------------------------------------------------

/**
 * The subset of JSON Schema primitive types supported by the Chalie daemon SDK
 * for capability parameter definitions.
 */
type ParameterType = "string" | "number" | "integer" | "boolean" | "object";

/**
 * A single parameter accepted by a capability.
 *
 * Mirrors the SDK's `Parameter` interface.  `type` is restricted to the SDK's
 * supported set of JSON-Schema-style primitives.
 */
interface Parameter {
  /** Parameter identifier used as the key in the `params` object. */
  name: string;
  /**
   * JSON-Schema primitive type.
   *
   * Note: there is no `"array"` type in the SDK's type union; array-valued
   * inputs (e.g. a list of email addresses) must be passed as comma-separated
   * strings and split by the handler.
   */
  type: ParameterType;
  /** Whether the LLM must supply this parameter. */
  required: boolean;
  /** Short description shown to the LLM as part of the tool schema. */
  description: string;
  /** Optional default value used when the parameter is omitted. */
  default?: unknown;
}

/**
 * A capability exposed to Chalie's ACT loop.
 *
 * Mirrors the SDK's `Capability` interface.
 */
interface Capability {
  /** Unique snake_case identifier used by `executeCommand()`. */
  name: string;
  /** One-line summary shown to the LLM. */
  description: string;
  /**
   * Longer documentation string with usage hints.
   *
   * The LLM sees both `description` and `documentation`, so use `description`
   * for the terse one-liner and `documentation` for nuance and examples.
   */
  documentation?: string;
  /** Ordered list of accepted parameters. */
  parameters: Parameter[];
  /** Human-readable description of the return value. */
  returns?: string;
}

// ---------------------------------------------------------------------------
// ALL_CAPABILITIES — exactly 12 LLM-facing tools
// ---------------------------------------------------------------------------

/**
 * The complete list of capabilities advertised to Chalie's LLM ACT loop.
 *
 * **Must contain exactly 12 entries.**  Internal helpers (`_setup_disconnect`,
 * etc.) are handled in `daemon.ts` and must NOT be added here.
 *
 * Order within the array does not affect functionality; it is preserved for
 * readability (Gmail first, then Calendar, then settings).
 */
export const ALL_CAPABILITIES: Capability[] = [
  // ── Gmail ──────────────────────────────────────────────────────────────────

  {
    name: "gmail_search",
    description: "Search Gmail messages using a query string.",
    documentation:
      "Searches the authenticated Gmail account using Gmail's native query syntax " +
      "(e.g. `from:alice is:unread subject:invoice`). Returns a list of matching " +
      "message summaries ordered newest-first.  Use `gmail_get` to fetch the full " +
      "body of a specific message.",
    parameters: [
      {
        name: "query",
        type: "string",
        required: true,
        description:
          "Gmail search query, e.g. \"from:alice is:unread\" or \"subject:invoice\".",
      },
      {
        name: "max_results",
        type: "integer",
        required: false,
        description: "Maximum number of messages to return (1–500).",
        default: 20,
      },
    ],
    returns:
      "Array of email summaries: id, threadId, from, subject, date, snippet, " +
      "labels, isUnread.",
  },

  {
    name: "gmail_get",
    description: "Fetch the full content of a Gmail message by ID.",
    documentation:
      "Downloads the complete message resource including decoded body text. " +
      "Prefers `text/plain` parts; falls back to HTML with tag-stripping. " +
      "Use the `id` returned by `gmail_search`.",
    parameters: [
      {
        name: "id",
        type: "string",
        required: true,
        description: "Gmail message ID (from a gmail_search result).",
      },
    ],
    returns:
      "Full email detail: id, threadId, from, to, cc, subject, date, snippet, " +
      "body (plain text), labels, isUnread.",
  },

  {
    name: "gmail_draft",
    description: "Create a Gmail draft (does not send).",
    documentation:
      "Creates a new draft in the authenticated Gmail account.  The draft is " +
      "**not sent** — this is a deliberate safety constraint.  The user can review " +
      "and send it from Gmail.  Returns the draft ID.",
    parameters: [
      {
        name: "to",
        type: "string",
        required: true,
        description:
          "Recipient email address or \"Display Name <address>\" format.",
      },
      {
        name: "subject",
        type: "string",
        required: true,
        description: "Email subject line.",
      },
      {
        name: "body",
        type: "string",
        required: true,
        description: "Plain-text body of the draft.",
      },
    ],
    returns: "Object containing the new draft ID: { draft_id: string }.",
  },

  {
    name: "gmail_move",
    description: "Add a label to a Gmail message.",
    documentation:
      "Applies a label to the specified message via the `messages.modify` endpoint. " +
      "Existing labels are preserved.  Use `gmail_labels` to discover available " +
      "label IDs.  Common system labels: STARRED, IMPORTANT, INBOX, TRASH.",
    parameters: [
      {
        name: "message_id",
        type: "string",
        required: true,
        description: "Gmail message ID to label.",
      },
      {
        name: "label_id",
        type: "string",
        required: true,
        description:
          "Label ID to add (e.g. \"STARRED\", \"IMPORTANT\", or a user label ID).",
      },
    ],
    returns: "{ ok: true } on success.",
  },

  {
    name: "gmail_trash",
    description: "Move a Gmail message to the Trash.",
    documentation:
      "Moves the message to Trash.  The message is retained for 30 days before " +
      "permanent deletion and can be restored from the Gmail UI.  This does not " +
      "permanently delete the message.",
    parameters: [
      {
        name: "message_id",
        type: "string",
        required: true,
        description: "Gmail message ID to trash.",
      },
    ],
    returns: "{ ok: true } on success.",
  },

  {
    name: "gmail_labels",
    description: "List all Gmail labels in the account.",
    documentation:
      "Returns both system labels (INBOX, SENT, TRASH, UNREAD, etc.) and " +
      "user-created labels.  Use the returned `id` values with `gmail_move` " +
      "to apply labels to messages.",
    parameters: [],
    returns:
      "Array of label objects: { id: string, name: string, type: \"system\"|\"user\" }.",
  },

  // ── Calendar ───────────────────────────────────────────────────────────────

  {
    name: "calendar_list",
    description: "List all Google Calendars in the account.",
    documentation:
      "Returns the user's calendar list including the primary calendar and any " +
      "subscribed or shared calendars.  Use the returned `id` values with " +
      "`calendar_events` or `calendar_create` to scope operations to a specific " +
      "calendar.",
    parameters: [],
    returns:
      "Array of calendar objects: { id: string, summary: string, primary?: boolean }.",
  },

  {
    name: "calendar_events",
    description: "List calendar events for a given time range or timeframe.",
    documentation:
      "Fetches events across all calendars (or a specific calendar if " +
      "`calendar_id` is supplied).  Accepts either a named `timeframe` keyword " +
      "or explicit `start_date`/`end_date` ISO date strings (YYYY-MM-DD). " +
      "Supported timeframe values: today, tomorrow, yesterday, this week, " +
      "next week, next N days, this month.  All-day events are included; " +
      "results are sorted by start time.",
    parameters: [
      {
        name: "timeframe",
        type: "string",
        required: false,
        description:
          "Named time window: \"today\", \"tomorrow\", \"this week\", " +
          "\"next week\", \"next 7 days\", etc.  Ignored when start_date is set.",
      },
      {
        name: "start_date",
        type: "string",
        required: false,
        description:
          "Inclusive start date in YYYY-MM-DD format.  Overrides timeframe.",
      },
      {
        name: "end_date",
        type: "string",
        required: false,
        description:
          "Inclusive end date in YYYY-MM-DD format.  Defaults to start_date when omitted.",
      },
      {
        name: "calendar_id",
        type: "string",
        required: false,
        description:
          "Specific calendar ID to query.  Omit to query all calendars.",
      },
    ],
    returns:
      "Array of event objects: id, summary, description, start, end, allDay, " +
      "location, attendees, htmlLink, calendarId.",
  },

  {
    name: "calendar_create",
    description: "Create a new event on Google Calendar.",
    documentation:
      "Creates an event on the specified calendar (defaults to \"primary\"). " +
      "For timed events provide ISO 8601 datetimes with timezone offset " +
      "(e.g. \"2026-03-18T14:00:00-05:00\").  For all-day events set " +
      "`all_day: true` and use YYYY-MM-DD date strings.  Attendees are a " +
      "comma-separated list of email addresses.",
    parameters: [
      {
        name: "summary",
        type: "string",
        required: true,
        description: "Event title.",
      },
      {
        name: "start",
        type: "string",
        required: true,
        description:
          "Start datetime (ISO 8601 with timezone) or date (YYYY-MM-DD for all-day).",
      },
      {
        name: "end",
        type: "string",
        required: true,
        description:
          "End datetime (ISO 8601 with timezone) or date (YYYY-MM-DD for all-day).",
      },
      {
        name: "all_day",
        type: "boolean",
        required: false,
        description: "Set true for all-day events (use YYYY-MM-DD start/end).",
        default: false,
      },
      {
        name: "calendar_id",
        type: "string",
        required: false,
        description: "Target calendar ID.  Defaults to \"primary\".",
        default: "primary",
      },
      {
        name: "description",
        type: "string",
        required: false,
        description: "Optional longer event description.",
      },
      {
        name: "location",
        type: "string",
        required: false,
        description:
          "Physical or virtual location (address, meeting URL, etc.).",
      },
      {
        name: "attendees",
        type: "string",
        required: false,
        description:
          "Comma-separated email addresses to invite, e.g. \"alice@example.com, bob@example.com\".",
      },
    ],
    returns:
      "The created event object including the server-assigned id and htmlLink.",
  },

  {
    name: "calendar_update",
    description: "Update an existing Google Calendar event.",
    documentation:
      "Applies a partial patch to the specified event using the Calendar API's " +
      "`events.patch` endpoint.  Only fields you supply are changed; all other " +
      "event fields are left untouched.  To change a timed event to all-day, " +
      "set `all_day: true` and provide date-only strings for start/end.",
    parameters: [
      {
        name: "calendar_id",
        type: "string",
        required: true,
        description: "Calendar ID that owns the event.",
      },
      {
        name: "event_id",
        type: "string",
        required: true,
        description: "ID of the event to update.",
      },
      {
        name: "summary",
        type: "string",
        required: false,
        description: "New event title.",
      },
      {
        name: "start",
        type: "string",
        required: false,
        description: "New start datetime or date.",
      },
      {
        name: "end",
        type: "string",
        required: false,
        description: "New end datetime or date.",
      },
      {
        name: "all_day",
        type: "boolean",
        required: false,
        description: "Set true to change to an all-day event.",
      },
      {
        name: "description",
        type: "string",
        required: false,
        description: "New event description.",
      },
      {
        name: "location",
        type: "string",
        required: false,
        description: "New event location.",
      },
    ],
    returns: "The updated event object as returned by Google after patching.",
  },

  {
    name: "calendar_delete",
    description: "Permanently delete a Google Calendar event.",
    documentation:
      "Deletes the specified event via `events.delete`.  The deletion is " +
      "immediate and **permanent** — the event cannot be recovered through the " +
      "API.  Confirm with the user before calling this capability.",
    parameters: [
      {
        name: "calendar_id",
        type: "string",
        required: true,
        description: "Calendar ID that owns the event.",
      },
      {
        name: "event_id",
        type: "string",
        required: true,
        description: "ID of the event to delete.",
      },
    ],
    returns: "{ ok: true } on successful deletion.",
  },

  // ── Settings ───────────────────────────────────────────────────────────────

  {
    name: "update_settings",
    description: "Update the Google interface sync settings.",
    documentation:
      "Persists one or more sync preferences to `settings.json`.  Only the " +
      "fields you supply are changed; omitted fields retain their current values. " +
      "Interval changes take effect within one minute without restarting the daemon.",
    parameters: [
      {
        name: "emailSyncEnabled",
        type: "boolean",
        required: false,
        description: "Enable or disable automatic email sync and notifications.",
      },
      {
        name: "emailSyncInterval",
        type: "integer",
        required: false,
        description: "Email sync frequency in minutes (valid: 5, 15, 30, 60).",
      },
      {
        name: "calendarSyncEnabled",
        type: "boolean",
        required: false,
        description: "Enable or disable automatic calendar sync and reminders.",
      },
      {
        name: "calendarSyncInterval",
        type: "integer",
        required: false,
        description:
          "Calendar sync frequency in minutes (valid: 1, 5, 15, 30).",
      },
    ],
    returns: "{ ok: true } on success.",
  },
];
