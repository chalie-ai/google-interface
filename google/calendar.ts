/**
 * Google Calendar REST API client for the Chalie Google Interface daemon.
 *
 * Wraps the Calendar v3 REST API with typed helpers for the five operations
 * Chalie needs: listing calendars, listing events, creating events, updating
 * events, and deleting events.
 *
 * ## Design notes
 *
 * - All network requests go through {@link googleFetch} from `api-utils.ts`,
 *   which attaches the `Authorization` header and maps HTTP error codes to
 *   typed error classes (`AuthError`, `RateLimitError`, `GoogleApiError`).
 * - {@link listEvents} detects whether each event is all-day by checking
 *   whether Google returned a `{ date }` object (all-day) or a `{ dateTime }`
 *   object (timed), and normalises the `start`/`end` fields to ISO strings.
 * - {@link createEvent} maps the `allDay` boolean on the input `CalendarEvent`
 *   to either `{ date: "YYYY-MM-DD" }` or `{ dateTime: "..." }` in the
 *   Google API request body.
 * - All timestamps passed to `listEvents` (`timeMin`, `timeMax`) must be
 *   RFC 3339 strings as required by the Google Calendar API.
 *
 * @module
 */

import { AuthError, GoogleApiError, RateLimitError, googleFetch } from "./api-utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for all Calendar API v3 requests. */
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Internal Google API shapes (raw response types)
// ---------------------------------------------------------------------------

/**
 * A single item in a Google `calendarList.list` response.
 *
 * Only the fields used by this module are typed; the full resource contains
 * many more fields (timeZone, backgroundColor, etc.) that are ignored.
 */
interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
}

/** Top-level `calendarList.list` API response. */
interface GoogleCalendarListResponse {
  items?: GoogleCalendarListEntry[];
}

/**
 * A Google Calendar `{ dateTime }` or `{ date }` time object.
 *
 * Google uses `dateTime` for timed events (ISO 8601 with timezone) and `date`
 * for all-day events (plain `YYYY-MM-DD` strings).
 */
interface GoogleEventTime {
  /** RFC 3339 timestamp — present for timed events. */
  dateTime?: string;
  /** Plain date string `YYYY-MM-DD` — present for all-day events. */
  date?: string;
  /** IANA timezone name associated with the time (e.g. `"America/New_York"`). */
  timeZone?: string;
}

/** A single attendee in a Google Calendar event resource. */
interface GoogleEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
}

/** Full event resource returned by `events.get` / `events.list`. */
interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GoogleEventTime;
  end: GoogleEventTime;
  attendees?: GoogleEventAttendee[];
  htmlLink?: string;
}

/** Top-level `events.list` API response. */
interface GoogleCalendarEventListResponse {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A Google Calendar event, normalised for use in Chalie.
 *
 * Produced by {@link listEvents} and returned by {@link createEvent} and
 * {@link updateEvent}.
 */
export interface CalendarEvent {
  /** Unique Google Calendar event ID. */
  id: string;
  /** Event title / summary. */
  summary: string;
  /** Optional longer description of the event. */
  description?: string;
  /**
   * ISO 8601 start datetime string.
   *
   * For timed events this is a full RFC 3339 string (e.g.
   * `"2026-03-18T14:00:00-05:00"`). For all-day events it is a plain date
   * string (e.g. `"2026-03-18"`).
   */
  start: string;
  /**
   * ISO 8601 end datetime string.
   *
   * Same format rules as {@link start}.
   */
  end: string;
  /** Optional physical or virtual location of the event. */
  location?: string;
  /**
   * Email addresses of invited attendees.
   *
   * Empty array when no attendees are listed on the event.
   */
  attendees?: string[];
  /**
   * `true` when this is an all-day event (Google returned a `{ date }` time
   * object rather than `{ dateTime }`).
   */
  allDay: boolean;
  /** Deep-link URL to view the event in Google Calendar. */
  htmlLink?: string;
  /** ID of the calendar this event belongs to. */
  calendarId: string;
}

/**
 * A Google Calendar (calendar list entry), as returned by {@link listCalendars}.
 */
export interface Calendar {
  /** Unique calendar ID (e.g. `"primary"` or a full email-style ID). */
  id: string;
  /** Human-readable calendar name. */
  summary: string;
  /** `true` when this is the user's primary calendar. */
  primary?: boolean;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract a normalised ISO datetime string and allDay flag from a Google
 * Calendar event time object.
 *
 * Google uses two mutually exclusive fields:
 * - `{ dateTime: "RFC-3339" }` — timed event.
 * - `{ date: "YYYY-MM-DD" }` — all-day event.
 *
 * @param time - The Google Calendar `start` or `end` time object.
 * @returns An object with the normalised `value` string and `allDay` boolean.
 *          Falls back to an empty string and `false` if neither field is set.
 */
function parseEventTime(time: GoogleEventTime): { value: string; allDay: boolean } {
  if (time.date) {
    return { value: time.date, allDay: true };
  }
  if (time.dateTime) {
    return { value: time.dateTime, allDay: false };
  }
  return { value: "", allDay: false };
}

/**
 * Convert a raw Google Calendar event resource to a {@link CalendarEvent}.
 *
 * @param raw        - The raw event object from the Google API.
 * @param calendarId - The calendar ID the event belongs to (not present on
 *                     the event resource itself).
 * @returns A normalised {@link CalendarEvent}.
 */
function toCalendarEvent(raw: GoogleCalendarEvent, calendarId: string): CalendarEvent {
  const startParsed = parseEventTime(raw.start);
  const endParsed = parseEventTime(raw.end);

  const event: CalendarEvent = {
    id: raw.id,
    summary: raw.summary ?? "",
    start: startParsed.value,
    end: endParsed.value,
    allDay: startParsed.allDay,
    calendarId,
  };

  if (raw.description !== undefined) event.description = raw.description;
  if (raw.location !== undefined) event.location = raw.location;
  if (raw.htmlLink !== undefined) event.htmlLink = raw.htmlLink;
  if (raw.attendees && raw.attendees.length > 0) {
    event.attendees = raw.attendees.map((a) => a.email);
  }

  return event;
}

/**
 * Map a {@link CalendarEvent} (or partial thereof) to the Google Calendar API
 * event resource request body.
 *
 * Converts:
 * - `summary`, `description`, `location` → direct fields.
 * - `start` / `end` + `allDay` → `{ date }` or `{ dateTime }` objects.
 * - `attendees` (array of email strings) → `[{ email }]` objects.
 *
 * Fields that are `undefined` on the input are omitted from the body so that
 * PATCH requests only update the fields explicitly provided.
 *
 * @param event - Partial {@link CalendarEvent} with the fields to include.
 * @returns A plain object ready to pass as the JSON body to the Google API.
 */
function toGoogleEventBody(
  event: Partial<CalendarEvent>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (event.summary !== undefined) body.summary = event.summary;
  if (event.description !== undefined) body.description = event.description;
  if (event.location !== undefined) body.location = event.location;

  if (event.start !== undefined) {
    body.start = event.allDay
      ? { date: event.start }
      : { dateTime: event.start };
  }
  if (event.end !== undefined) {
    body.end = event.allDay
      ? { date: event.end }
      : { dateTime: event.end };
  }

  if (event.attendees !== undefined) {
    body.attendees = event.attendees.map((email) => ({ email }));
  }

  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all calendars in the authenticated user's calendar list.
 *
 * Calls the `calendarList.list` endpoint and returns a flat array of
 * {@link Calendar} objects.  The user's primary calendar is identified by
 * `primary: true`.
 *
 * @param token - Valid OAuth2 access token with the `calendar` scope.
 *
 * @returns Array of {@link Calendar} objects. Returns an empty array when the
 *          calendar list is empty.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Calendar API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const calendars = await listCalendars(token);
 * const primary = calendars.find(c => c.primary);
 */
export async function listCalendars(token: string): Promise<Calendar[]> {
  const response = await googleFetch<GoogleCalendarListResponse>(
    `${CALENDAR_BASE}/users/me/calendarList`,
    token,
  );

  return (response.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary,
    ...(item.primary !== undefined ? { primary: item.primary } : {}),
  }));
}

/**
 * List events on a specific calendar within a time range.
 *
 * Calls the `events.list` endpoint with `timeMin` and `timeMax` bounds (both
 * required by this wrapper to prevent unbounded result sets).  Correctly
 * handles both timed events (`{ dateTime }`) and all-day events (`{ date }`)
 * in the `start` / `end` fields.
 *
 * @param token      - Valid OAuth2 access token with the `calendar` scope.
 * @param calendarId - Calendar ID to query (use `"primary"` for the primary
 *                     calendar).
 * @param timeMin    - RFC 3339 timestamp for the lower bound (inclusive).
 *                     Example: `"2026-03-18T00:00:00Z"`.
 * @param timeMax    - RFC 3339 timestamp for the upper bound (exclusive).
 *                     Example: `"2026-03-25T00:00:00Z"`.
 * @param maxResults - Maximum number of events to return (1–2500).
 *                     Defaults to 50.
 *
 * @returns Array of {@link CalendarEvent} objects ordered by start time
 *          (ascending) as returned by the API. Returns an empty array when no
 *          events fall within the range.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Calendar API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const events = await listEvents(
 *   token,
 *   "primary",
 *   "2026-03-18T00:00:00Z",
 *   "2026-03-25T00:00:00Z",
 * );
 */
export async function listEvents(
  token: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  maxResults = 50,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const encodedCalendarId = encodeURIComponent(calendarId);
  const response = await googleFetch<GoogleCalendarEventListResponse>(
    `${CALENDAR_BASE}/calendars/${encodedCalendarId}/events?${params.toString()}`,
    token,
  );

  return (response.items ?? []).map((item) => toCalendarEvent(item, calendarId));
}

/**
 * Create a new event on the specified calendar.
 *
 * Maps a {@link CalendarEvent} (or partial thereof) to the Google API event
 * resource format:
 * - `allDay: true`  → `start: { date: "YYYY-MM-DD" }` / `end: { date: ... }`
 * - `allDay: false` → `start: { dateTime: "RFC-3339" }` / `end: { dateTime: ... }`
 * - `attendees`     → `[{ email }]` objects
 *
 * @param token      - Valid OAuth2 access token with the `calendar` scope.
 * @param calendarId - Calendar ID to create the event on (use `"primary"` for
 *                     the primary calendar).
 * @param event      - Event data. `summary`, `start`, `end`, and `allDay` are
 *                     effectively required for a meaningful event.
 *
 * @returns The newly created {@link CalendarEvent} as returned by Google
 *          (includes the server-assigned `id` and `htmlLink`).
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Calendar API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const created = await createEvent(token, "primary", {
 *   summary: "Team Sync",
 *   start: "2026-03-20T10:00:00-05:00",
 *   end:   "2026-03-20T11:00:00-05:00",
 *   allDay: false,
 * });
 */
export async function createEvent(
  token: string,
  calendarId: string,
  event: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const raw = await googleFetch<GoogleCalendarEvent>(
    `${CALENDAR_BASE}/calendars/${encodedCalendarId}/events`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGoogleEventBody(event)),
    },
  );

  return toCalendarEvent(raw, calendarId);
}

/**
 * Permanently delete an event from the specified calendar.
 *
 * Calls the `events.delete` endpoint. The event is immediately removed and
 * cannot be recovered through the API.
 *
 * @param token      - Valid OAuth2 access token with the `calendar` scope.
 * @param calendarId - Calendar ID that owns the event.
 * @param eventId    - ID of the event to delete.
 *
 * @returns A promise that resolves when the event has been deleted (HTTP 204).
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Calendar API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * await deleteEvent(token, "primary", event.id);
 */
export async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);

  // events.delete returns HTTP 204 No Content on success — no JSON body.
  const url = `${CALENDAR_BASE}/calendars/${encodedCalendarId}/events/${encodedEventId}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    throw new AuthError();
  }
  if (response.status === 429) {
    throw new RateLimitError();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(`Google API error ${response.status}: ${body}`, response.status);
  }
  // 204 No Content — nothing to return.
}

/**
 * Update an existing calendar event using a partial patch.
 *
 * Only the fields present on `updates` are sent to the API; all other event
 * fields are left unchanged.  Uses the `events.patch` endpoint (PATCH
 * semantics) rather than `events.update` (PUT semantics) to minimise the risk
 * of accidentally clearing fields that were not included in the call.
 *
 * @param token      - Valid OAuth2 access token with the `calendar` scope.
 * @param calendarId - Calendar ID that owns the event.
 * @param eventId    - ID of the event to update.
 * @param updates    - Partial {@link CalendarEvent} containing only the fields
 *                     to change. Fields not included here are unchanged.
 *
 * @returns The updated {@link CalendarEvent} as returned by Google after
 *          applying the patch.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Calendar API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const updated = await updateEvent(token, "primary", event.id, {
 *   summary: "Team Sync (rescheduled)",
 *   start: "2026-03-21T10:00:00-05:00",
 *   end:   "2026-03-21T11:00:00-05:00",
 *   allDay: false,
 * });
 */
export async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);

  const raw = await googleFetch<GoogleCalendarEvent>(
    `${CALENDAR_BASE}/calendars/${encodedCalendarId}/events/${encodedEventId}`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toGoogleEventBody(updates)),
    },
  );

  return toCalendarEvent(raw, calendarId);
}
