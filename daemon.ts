/**
 * Main entry point for the Chalie Google Interface daemon.
 *
 * ## Responsibilities
 *
 * 1. Ensure the persistent data directory exists at startup.
 * 2. Start the OAuth callback HTTP server on port 9004 if no Google account is
 *    connected yet.
 * 3. Wire the SDK's `sendMessage` / `sendSignal` functions into sub-modules via
 *    dependency injection so those modules do not import `chalie:sdk` directly.
 * 4. Define {@link executeCommand} — the single dispatch function that handles
 *    all 12 LLM-facing capabilities plus the internal `_setup_disconnect`
 *    command.
 * 5. Define {@link renderInterface} — returns the setup wizard when no account
 *    is connected, otherwise the main Gmail/Calendar dashboard.
 * 6. Call {@link createDaemon} to register the daemon with Chalie's ACT loop.
 *
 * ## Error handling contract
 *
 * `executeCommand` never throws.  Instead it returns a plain `{ error: string }`
 * object so the LLM receives a human-readable explanation rather than an
 * unhandled exception trace.  The three error tiers are:
 *
 * - `AuthError`       → prompts the user to re-authorize.
 * - `RateLimitError`  → asks the user to retry later.
 * - Other `Error`     → surfaces `err.message` verbatim.
 *
 * @module
 */

import {
  createDaemon,
  sendMessage,
  sendSignal,
  getContext,
  minutes,
  CONSTANTS,
} from "chalie:sdk";

import { getDataDir } from "./lib/data-dir.ts";
import { AuthError, RateLimitError } from "./google/api-utils.ts";
import {
  clearCredentials,
  getAccessToken,
  getConnectedEmail,
  initAuth,
  isConfigured,
  startOAuthCallbackServer,
} from "./google/auth.ts";
import {
  createDraft,
  getMessage,
  listLabels,
  listMessages,
  moveTo,
  trashMessage,
} from "./google/gmail.ts";
import {
  createEvent,
  deleteEvent,
  listCalendars,
  listEvents,
  updateEvent,
} from "./google/calendar.ts";
import { calendarSyncTick, initCalendarSync } from "./sync/calendar-sync.ts";
import { emailSyncTick, initEmailSync } from "./sync/email-sync.ts";
import {
  loadSettings,
  saveSettings,
  renderSettingsPanel,
} from "./ui/settings.ts";
import { renderMainView } from "./ui/main.ts";
import { renderSetupWizard } from "./ui/setup.ts";
import { ALL_CAPABILITIES } from "./capabilities.ts";

// ---------------------------------------------------------------------------
// Startup initialisation
// ---------------------------------------------------------------------------

/**
 * Ensure the persistent data directory exists.
 *
 * All sub-modules derive file paths from `getDataDir()`; this call guarantees
 * the directory is present before any module attempts a read or write.
 */
const dataDir = getDataDir();
await Deno.mkdir(dataDir, { recursive: true });

/**
 * Start the OAuth callback server on port 9004 when no Google account is
 * connected.
 *
 * The server drives the browser-based consent flow rendered by the setup
 * wizard.  It shuts itself down automatically after credentials are obtained
 * via `GET /oauth/callback`.
 */
if (!isConfigured()) {
  startOAuthCallbackServer(9004);
}

// Wire SDK functions into sub-modules via dependency injection.
// These calls must precede any poll tick or capability execution.
initAuth(sendMessage);
initEmailSync(sendSignal);
initCalendarSync(sendSignal, sendMessage);

// ---------------------------------------------------------------------------
// Date / timezone helpers
// ---------------------------------------------------------------------------

/**
 * Convert a date expressed in a given IANA timezone to a UTC `Date` object
 * at midnight (00:00:00) of that date in that timezone.
 *
 * Handles month/day overflow automatically (e.g., day 32 → first of next
 * month) because `Date.UTC` normalises its inputs.
 *
 * @param year  - Full four-digit year (UTC-normalised from `Date.UTC`).
 * @param month - 1-based month number (1 = January).
 * @param day   - Day of the month (may overflow; normalised by `Date.UTC`).
 * @param tz    - IANA timezone identifier, e.g. `"America/New_York"`.
 * @returns `Date` representing midnight in the specified timezone as a UTC
 *          instant.
 */
function tzMidnight(year: number, month: number, day: number, tz: string): Date {
  // Use noon UTC as a stable reference that avoids DST edge cases at midnight.
  const refUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Find out what local date/time the reference corresponds to in `tz`.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const fmtParts: Record<string, number> = {};
  for (const part of fmt.formatToParts(refUTC)) {
    if (part.type !== "literal") {
      fmtParts[part.type] = parseInt(part.value, 10);
    }
  }

  // Reconstruct the "displayed local noon" as a UTC millisecond timestamp.
  const localNoonHour = fmtParts.hour === 24 ? 0 : fmtParts.hour;
  const displayedNoonMs = Date.UTC(
    fmtParts.year,
    fmtParts.month - 1,
    fmtParts.day,
    localNoonHour,
    fmtParts.minute,
    fmtParts.second,
  );

  // The offset (in ms) between UTC and local time for this timezone:
  //   offsetMs > 0 → timezone is behind UTC (e.g. America/New_York at UTC-5)
  //   offsetMs < 0 → timezone is ahead of UTC (e.g. Asia/Tokyo at UTC+9)
  const offsetMs = refUTC.getTime() - displayedNoonMs;

  // Apply the same offset to local midnight to get the UTC instant.
  const localMidnightAsUTCMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  return new Date(localMidnightAsUTCMs + offsetMs);
}

/**
 * Resolve a named timeframe keyword to RFC 3339 `timeMin` / `timeMax` bounds
 * suitable for the Google Calendar API.
 *
 * Supported keywords (case-insensitive):
 * `today`, `tomorrow`, `yesterday`, `this week`, `next week`, `this month`,
 * `next N days` (where N is a positive integer).
 *
 * "Week" boundaries are Monday–Sunday.
 *
 * @param timeframe - The keyword string to resolve.
 * @param tz        - IANA timezone identifier used to determine "today".
 *                    Defaults to `"UTC"` when invalid or absent.
 * @returns Object with `timeMin` and `timeMax` RFC 3339 strings, or `null`
 *          if the keyword is not recognised.
 */
function resolveTimeframeBounds(
  timeframe: string,
  tz: string,
): { timeMin: string; timeMax: string } | null {
  const tf = timeframe.toLowerCase().trim();
  const now = new Date();

  // Determine the current date in the user's timezone.
  const todayParts: Record<string, number> = {};
  for (
    const part of new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now)
  ) {
    if (part.type !== "literal") todayParts[part.type] = parseInt(part.value, 10);
  }

  const yr = todayParts.year;
  const mo = todayParts.month;
  const dy = todayParts.day;

  /** Duration of one day in milliseconds. */
  const DAY_MS = 86_400_000;

  /**
   * Build a `{ timeMin, timeMax }` pair spanning exactly `n` whole days
   * starting from `start`.
   *
   * @param start - UTC `Date` for the first midnight.
   * @param n     - Number of days to span.
   * @returns RFC 3339 string pair.
   */
  function rangeFromMidnight(
    start: Date,
    n = 1,
  ): { timeMin: string; timeMax: string } {
    const end = new Date(start.getTime() + n * DAY_MS - 1);
    return { timeMin: start.toISOString(), timeMax: end.toISOString() };
  }

  if (tf === "today") {
    return rangeFromMidnight(tzMidnight(yr, mo, dy, tz));
  }
  if (tf === "tomorrow") {
    return rangeFromMidnight(tzMidnight(yr, mo, dy + 1, tz));
  }
  if (tf === "yesterday") {
    return rangeFromMidnight(tzMidnight(yr, mo, dy - 1, tz));
  }
  if (tf === "this week") {
    // Day-of-week for today in user timezone (0 = Sun, 1 = Mon, …)
    const todayMidnight = tzMidnight(yr, mo, dy, tz);
    const dow = todayMidnight.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow; // Monday of this week
    return rangeFromMidnight(tzMidnight(yr, mo, dy + mondayOffset, tz), 7);
  }
  if (tf === "next week") {
    const todayMidnight = tzMidnight(yr, mo, dy, tz);
    const dow = todayMidnight.getDay();
    const mondayOffset = dow === 0 ? 1 : 8 - dow; // Monday of next week
    return rangeFromMidnight(tzMidnight(yr, mo, dy + mondayOffset, tz), 7);
  }
  if (tf === "this month") {
    const start = tzMidnight(yr, mo, 1, tz);
    // Last day of this month: day 0 of next month
    const lastDay = new Date(yr, mo, 0).getDate();
    return rangeFromMidnight(start, lastDay);
  }

  // "next N days" — e.g. "next 7 days", "next 14 days"
  const nextNMatch = tf.match(/^next (\d+) days?$/);
  if (nextNMatch) {
    const n = parseInt(nextNMatch[1], 10);
    return rangeFromMidnight(tzMidnight(yr, mo, dy, tz), n);
  }

  return null; // Unrecognised timeframe keyword.
}

/**
 * Convert a plain `YYYY-MM-DD` date string to an RFC 3339 start-of-day
 * timestamp in the given timezone.
 *
 * @param dateStr - Date string in `YYYY-MM-DD` format.
 * @param tz      - IANA timezone identifier.
 * @returns RFC 3339 string for midnight at the start of that date.
 */
function dateStrToTimeMin(dateStr: string, tz: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return tzMidnight(year, month, day, tz).toISOString();
}

/**
 * Convert a plain `YYYY-MM-DD` date string to an RFC 3339 end-of-day
 * timestamp in the given timezone (23:59:59.999).
 *
 * @param dateStr - Date string in `YYYY-MM-DD` format.
 * @param tz      - IANA timezone identifier.
 * @returns RFC 3339 string for the last millisecond of that date in `tz`.
 */
function dateStrToTimeMax(dateStr: string, tz: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const start = tzMidnight(year, month, day, tz);
  return new Date(start.getTime() + 86_400_000 - 1).toISOString();
}

// ---------------------------------------------------------------------------
// Capability handlers
// ---------------------------------------------------------------------------

/**
 * Handle the `gmail_search` capability.
 *
 * Searches the authenticated Gmail account using Gmail's native query syntax
 * and returns a list of matching message summaries.
 *
 * @param params - Command parameters.
 * @param params.query       - Gmail query string (required).
 * @param params.max_results - Maximum results to return; defaults to 20.
 * @returns Array of `EmailSummary` objects, newest-first.
 */
async function handleGmailSearch(
  params: Record<string, unknown>,
): Promise<unknown> {
  const query = String(params.query ?? "");
  const maxResults = typeof params.max_results === "number"
    ? Math.min(Math.max(1, params.max_results), 500)
    : 20;

  const token = await getAccessToken();
  return await listMessages(token, query, maxResults);
}

/**
 * Handle the `gmail_get` capability.
 *
 * Fetches the full content of a Gmail message by its ID, decoding the body
 * text and returning all header metadata.
 *
 * @param params        - Command parameters.
 * @param params.id     - Gmail message ID (required).
 * @returns Full `EmailDetail` object.
 */
async function handleGmailGet(
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = String(params.id ?? "");
  const token = await getAccessToken();
  return await getMessage(token, id);
}

/**
 * Handle the `gmail_draft` capability.
 *
 * Creates a new draft in the authenticated Gmail account.  The draft is
 * **not sent** — this is a deliberate safety constraint.
 *
 * @param params          - Command parameters.
 * @param params.to       - Recipient address (required).
 * @param params.subject  - Email subject line (required).
 * @param params.body     - Plain-text message body (required).
 * @returns Object containing the new draft ID: `{ draft_id: string }`.
 */
async function handleGmailDraft(
  params: Record<string, unknown>,
): Promise<unknown> {
  const to = String(params.to ?? "");
  const subject = String(params.subject ?? "");
  const body = String(params.body ?? "");

  const token = await getAccessToken();
  const draftId = await createDraft(token, to, subject, body);
  return { draft_id: draftId };
}

/**
 * Handle the `gmail_move` capability.
 *
 * Applies a label to the specified Gmail message.
 *
 * @param params             - Command parameters.
 * @param params.message_id  - Gmail message ID (required).
 * @param params.label_id    - Label ID to add (required).
 * @returns `{ ok: true }` on success.
 */
async function handleGmailMove(
  params: Record<string, unknown>,
): Promise<unknown> {
  const messageId = String(params.message_id ?? "");
  const labelId = String(params.label_id ?? "");

  const token = await getAccessToken();
  await moveTo(token, messageId, labelId);
  return { ok: true };
}

/**
 * Handle the `gmail_trash` capability.
 *
 * Moves the specified Gmail message to the Trash folder.
 *
 * @param params             - Command parameters.
 * @param params.message_id  - Gmail message ID to trash (required).
 * @returns `{ ok: true }` on success.
 */
async function handleGmailTrash(
  params: Record<string, unknown>,
): Promise<unknown> {
  const messageId = String(params.message_id ?? "");

  const token = await getAccessToken();
  await trashMessage(token, messageId);
  return { ok: true };
}

/**
 * Handle the `gmail_labels` capability.
 *
 * Returns all labels (system and user-created) in the authenticated Gmail
 * account.
 *
 * @param _params - No parameters required.
 * @returns Array of `{ id, name, type }` label objects.
 */
async function handleGmailLabels(
  _params: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  return await listLabels(token);
}

/**
 * Handle the `calendar_list` capability.
 *
 * Returns all calendars in the authenticated Google account.
 *
 * @param _params - No parameters required.
 * @returns Array of `{ id, summary, primary? }` calendar objects.
 */
async function handleCalendarList(
  _params: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  return await listCalendars(token);
}

/**
 * Handle the `calendar_events` capability.
 *
 * Lists calendar events for a given time range or named timeframe.  When
 * `calendar_id` is omitted all calendars are queried and results merged.
 *
 * Priority for date range:
 * 1. `start_date` (and optional `end_date`) explicit ISO date strings.
 * 2. `timeframe` named keyword.
 * 3. Default: `"today"`.
 *
 * @param params               - Command parameters.
 * @param params.timeframe     - Named time window keyword (optional).
 * @param params.start_date    - Inclusive start date YYYY-MM-DD (optional).
 * @param params.end_date      - Inclusive end date YYYY-MM-DD (optional).
 * @param params.calendar_id   - Specific calendar to query (optional).
 * @returns Array of `CalendarEvent` objects sorted by start time.
 */
async function handleCalendarEvents(
  params: Record<string, unknown>,
): Promise<unknown> {
  // Obtain the user's timezone for accurate day boundaries.
  const tzRaw = await getContext(CONSTANTS.SCOPES.TIMEZONE);
  const tz: string = typeof tzRaw === "string" && tzRaw.trim().length > 0
    ? tzRaw.trim()
    : "UTC";

  // Resolve the time range.
  let timeMin: string;
  let timeMax: string;

  const startDate = typeof params.start_date === "string"
    ? params.start_date.trim()
    : null;
  const endDate = typeof params.end_date === "string"
    ? params.end_date.trim()
    : null;

  if (startDate) {
    // Explicit date range takes priority over timeframe.
    timeMin = dateStrToTimeMin(startDate, tz);
    timeMax = endDate
      ? dateStrToTimeMax(endDate, tz)
      : dateStrToTimeMax(startDate, tz); // Default end = same day.
  } else {
    // Named timeframe (or default "today").
    const tf = typeof params.timeframe === "string" && params.timeframe.trim()
      ? params.timeframe.trim()
      : "today";
    const resolved = resolveTimeframeBounds(tf, tz);
    if (!resolved) {
      return {
        error:
          `Unrecognised timeframe "${params.timeframe}". Use: today, tomorrow, ` +
          `yesterday, this week, next week, this month, or "next N days".`,
      };
    }
    ({ timeMin, timeMax } = resolved);
  }

  const token = await getAccessToken();
  const calendarId = typeof params.calendar_id === "string" &&
      params.calendar_id.trim()
    ? params.calendar_id.trim()
    : null;

  if (calendarId) {
    // Single-calendar query.
    return await listEvents(token, calendarId, timeMin, timeMax);
  }

  // Multi-calendar query: fetch all calendars then merge events.
  const calendars = await listCalendars(token);
  const eventArrays = await Promise.all(
    calendars.map((cal) => listEvents(token, cal.id, timeMin, timeMax)),
  );

  // Flatten and sort by start time ascending.
  const allEvents = eventArrays.flat();
  allEvents.sort((a, b) => {
    const ta = new Date(a.start).getTime();
    const tb = new Date(b.start).getTime();
    return ta - tb;
  });

  return allEvents;
}

/**
 * Handle the `calendar_create` capability.
 *
 * Creates a new event on the specified calendar (defaults to `"primary"`).
 * Attendees are parsed from a comma-separated string.
 *
 * @param params             - Command parameters.
 * @param params.summary     - Event title (required).
 * @param params.start       - Start datetime or date string (required).
 * @param params.end         - End datetime or date string (required).
 * @param params.all_day     - `true` for all-day events (optional).
 * @param params.calendar_id - Target calendar ID (optional, default "primary").
 * @param params.description - Event description (optional).
 * @param params.location    - Event location (optional).
 * @param params.attendees   - Comma-separated attendee emails (optional).
 * @returns The created `CalendarEvent` object.
 */
async function handleCalendarCreate(
  params: Record<string, unknown>,
): Promise<unknown> {
  const calendarId = typeof params.calendar_id === "string" &&
      params.calendar_id.trim()
    ? params.calendar_id.trim()
    : "primary";

  const allDay = params.all_day === true;

  // Parse comma-separated attendees into an array.
  const attendees: string[] = typeof params.attendees === "string" &&
      params.attendees.trim()
    ? params.attendees.split(",").map((e) => e.trim()).filter(Boolean)
    : [];

  const event: Record<string, unknown> = {
    summary: String(params.summary ?? ""),
    start: String(params.start ?? ""),
    end: String(params.end ?? ""),
    allDay,
  };

  if (typeof params.description === "string" && params.description.trim()) {
    event.description = params.description.trim();
  }
  if (typeof params.location === "string" && params.location.trim()) {
    event.location = params.location.trim();
  }
  if (attendees.length > 0) {
    event.attendees = attendees;
  }

  const token = await getAccessToken();
  return await createEvent(token, calendarId, event);
}

/**
 * Handle the `calendar_update` capability.
 *
 * Applies a partial patch to an existing calendar event.  Only supplied fields
 * are changed; all others are preserved.
 *
 * @param params              - Command parameters.
 * @param params.calendar_id  - Calendar ID owning the event (required).
 * @param params.event_id     - Event ID to update (required).
 * @param params.summary      - New event title (optional).
 * @param params.start        - New start datetime or date (optional).
 * @param params.end          - New end datetime or date (optional).
 * @param params.all_day      - Set `true` to convert to all-day (optional).
 * @param params.description  - New description (optional).
 * @param params.location     - New location (optional).
 * @returns The updated `CalendarEvent` object.
 */
async function handleCalendarUpdate(
  params: Record<string, unknown>,
): Promise<unknown> {
  const calendarId = String(params.calendar_id ?? "");
  const eventId = String(params.event_id ?? "");

  const updates: Record<string, unknown> = {};

  if (typeof params.summary === "string") updates.summary = params.summary;
  if (typeof params.start === "string") updates.start = params.start;
  if (typeof params.end === "string") updates.end = params.end;
  if (typeof params.all_day === "boolean") updates.allDay = params.all_day;
  if (typeof params.description === "string") {
    updates.description = params.description;
  }
  if (typeof params.location === "string") updates.location = params.location;

  const token = await getAccessToken();
  return await updateEvent(token, calendarId, eventId, updates);
}

/**
 * Handle the `calendar_delete` capability.
 *
 * Permanently deletes the specified calendar event.
 *
 * @param params              - Command parameters.
 * @param params.calendar_id  - Calendar ID owning the event (required).
 * @param params.event_id     - Event ID to delete (required).
 * @returns `{ ok: true }` on success.
 */
async function handleCalendarDelete(
  params: Record<string, unknown>,
): Promise<unknown> {
  const calendarId = String(params.calendar_id ?? "");
  const eventId = String(params.event_id ?? "");

  const token = await getAccessToken();
  await deleteEvent(token, calendarId, eventId);
  return { ok: true };
}

/**
 * Valid email sync interval values (minutes).
 *
 * Enforced when the user updates `emailSyncInterval` via `update_settings`.
 */
const VALID_EMAIL_INTERVALS: ReadonlySet<number> = new Set([5, 15, 30, 60]);

/**
 * Valid calendar sync interval values (minutes).
 *
 * Enforced when the user updates `calendarSyncInterval` via `update_settings`.
 */
const VALID_CALENDAR_INTERVALS: ReadonlySet<number> = new Set([1, 5, 15, 30]);

/**
 * Handle the `update_settings` capability.
 *
 * Merges the supplied fields into the current settings, validates interval
 * values, and persists the result to `{dataDir}/settings.json`.
 *
 * @param params                       - Command parameters (all optional).
 * @param params.emailSyncEnabled      - Enable / disable email polling.
 * @param params.emailSyncInterval     - Email check frequency in minutes.
 * @param params.calendarSyncEnabled   - Enable / disable calendar polling.
 * @param params.calendarSyncInterval  - Calendar check frequency in minutes.
 * @returns `{ ok: true }` on success, or `{ error: string }` on validation
 *          failure.
 */
async function handleUpdateSettings(
  params: Record<string, unknown>,
): Promise<unknown> {
  // Validate interval values before loading and mutating settings.
  if (
    params.emailSyncInterval !== undefined &&
    !VALID_EMAIL_INTERVALS.has(params.emailSyncInterval as number)
  ) {
    return {
      error:
        `Invalid emailSyncInterval: ${params.emailSyncInterval}. ` +
        `Valid values are 5, 15, 30, or 60 minutes.`,
    };
  }
  if (
    params.calendarSyncInterval !== undefined &&
    !VALID_CALENDAR_INTERVALS.has(params.calendarSyncInterval as number)
  ) {
    return {
      error:
        `Invalid calendarSyncInterval: ${params.calendarSyncInterval}. ` +
        `Valid values are 1, 5, 15, or 30 minutes.`,
    };
  }

  const current = await loadSettings();

  const updated = {
    ...current,
    ...(typeof params.emailSyncEnabled === "boolean"
      ? { emailSyncEnabled: params.emailSyncEnabled }
      : {}),
    ...(typeof params.emailSyncInterval === "number"
      ? { emailSyncInterval: params.emailSyncInterval }
      : {}),
    ...(typeof params.calendarSyncEnabled === "boolean"
      ? { calendarSyncEnabled: params.calendarSyncEnabled }
      : {}),
    ...(typeof params.calendarSyncInterval === "number"
      ? { calendarSyncInterval: params.calendarSyncInterval }
      : {}),
  };

  await saveSettings(updated);
  return { ok: true };
}

/**
 * Handle the internal `_setup_disconnect` command.
 *
 * Clears all stored OAuth credentials, deletes sync state files so the next
 * connection starts fresh, and restarts the OAuth callback server so the
 * setup wizard can immediately begin a new authorization flow.
 *
 * This command is **not** included in {@link ALL_CAPABILITIES} and therefore
 * never appears in the LLM's tool list.  It is only invoked from the settings
 * panel UI via `window.chalie.execute("_setup_disconnect", {})`.
 *
 * @param _params - No parameters required.
 * @returns `{ ok: true }` on success.
 */
async function handleSetupDisconnect(
  _params: Record<string, unknown>,
): Promise<unknown> {
  // Remove credentials file (no-op if absent).
  await clearCredentials();

  // Delete sync state files so the next account starts fresh.
  for (const filename of ["email-sync-state.json", "calendar-sync-state.json"]) {
    try {
      await Deno.remove(`${getDataDir()}/${filename}`);
    } catch (err) {
      // Silently ignore "file not found" — treat as already gone.
      if (!(err instanceof Deno.errors.NotFound)) {
        console.error(
          `[daemon] Warning: could not delete ${filename}:`,
          err,
        );
      }
    }
  }

  // Restart the OAuth callback server so the setup wizard can proceed.
  startOAuthCallbackServer(9004);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// executeCommand
// ---------------------------------------------------------------------------

/**
 * Dispatch a capability name to its handler and return the result.
 *
 * This is the single entry point for all LLM-initiated actions and for the
 * internal `_setup_disconnect` command invoked by the settings UI.
 *
 * ### Error handling
 *
 * The function never throws.  Any exception raised by a handler is caught and
 * mapped to a `{ error: string }` object so the LLM always receives a
 * structured, human-readable response rather than an unhandled exception trace.
 *
 * | Error type       | Returned message                                     |
 * |------------------|------------------------------------------------------|
 * | `AuthError`      | Prompts the user to re-authorize in settings.        |
 * | `RateLimitError` | Asks the user to retry later.                        |
 * | Other `Error`    | Surfaces `err.message` verbatim.                     |
 * | Unknown throw    | Generic fallback message.                            |
 *
 * @param capability - The capability name (e.g. `"gmail_search"`).
 * @param params     - Key/value map of command parameters.
 * @returns The handler's return value, or `{ error: string }` on failure.
 */
async function executeCommand(
  capability: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    // Internal command — not in ALL_CAPABILITIES, not shown to the LLM.
    if (capability === "_setup_disconnect") {
      return await handleSetupDisconnect(params);
    }

    switch (capability) {
      // ── Gmail ─────────────────────────────────────────────────────────────
      case "gmail_search":
        return await handleGmailSearch(params);
      case "gmail_get":
        return await handleGmailGet(params);
      case "gmail_draft":
        return await handleGmailDraft(params);
      case "gmail_move":
        return await handleGmailMove(params);
      case "gmail_trash":
        return await handleGmailTrash(params);
      case "gmail_labels":
        return await handleGmailLabels(params);

      // ── Calendar ──────────────────────────────────────────────────────────
      case "calendar_list":
        return await handleCalendarList(params);
      case "calendar_events":
        return await handleCalendarEvents(params);
      case "calendar_create":
        return await handleCalendarCreate(params);
      case "calendar_update":
        return await handleCalendarUpdate(params);
      case "calendar_delete":
        return await handleCalendarDelete(params);

      // ── Settings ──────────────────────────────────────────────────────────
      case "update_settings":
        return await handleUpdateSettings(params);

      default:
        return { error: `Unknown capability: "${capability}".` };
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        error:
          "Google account not connected or authorization expired. " +
          "Please re-authorize in the Google interface settings.",
      };
    }
    if (err instanceof RateLimitError) {
      return {
        error:
          "Google API rate limit reached. Please try again in a moment.",
      };
    }
    if (err instanceof Error) {
      return { error: err.message };
    }
    return { error: "An unexpected error occurred." };
  }
}

// ---------------------------------------------------------------------------
// renderInterface
// ---------------------------------------------------------------------------

/**
 * Render the daemon's HTML interface.
 *
 * Routes to one of two views depending on authorization state:
 *
 * - **Not configured** → `renderSetupWizard()` — walks the user through
 *   creating a Google Cloud project and completing the OAuth consent flow.
 * - **Configured** → `renderMainView(email, settingsPanel)` — the full
 *   Gmail + Calendar dashboard with a live settings panel.
 *
 * @returns A complete HTML document string ready to be served by the SDK.
 */
async function renderInterface(): Promise<string> {
  if (!isConfigured()) {
    return renderSetupWizard();
  }

  const [email, settings] = await Promise.all([
    getConnectedEmail(),
    loadSettings(),
  ]);

  const settingsHtml = renderSettingsPanel(settings, email);
  return renderMainView(email, settingsHtml);
}

// ---------------------------------------------------------------------------
// createDaemon
// ---------------------------------------------------------------------------

/**
 * OAuth 2.0 scopes this daemon requests from Google.
 *
 * Matches the scopes defined in `google/auth.ts`.  Declared here for the
 * `createDaemon` registration so Chalie can display them to the user.
 */
const GOOGLE_SCOPES: string[] = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

createDaemon({
  name: "Google",
  version: "1.0.0",
  description:
    "Gmail and Google Calendar integration — search and manage emails, " +
    "create drafts, and view or edit calendar events.",
  scopes: GOOGLE_SCOPES,
  capabilities: ALL_CAPABILITIES,
  polls: [
    {
      name: "email-sync",
      every: minutes(1),
      run: emailSyncTick,
    },
    {
      name: "calendar-sync",
      every: minutes(1),
      run: calendarSyncTick,
    },
  ],
  executeCommand,
  renderInterface,
});
