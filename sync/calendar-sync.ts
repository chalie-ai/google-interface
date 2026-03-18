/**
 * Calendar polling tick for the Chalie Google Interface daemon.
 *
 * Implements a self-throttled polling strategy: the daemon registers this
 * module's tick function against a 1-minute base interval, but the tick
 * checks `settings.calendarSyncInterval` itself before doing any work.  This
 * allows users to change the sync interval from the settings panel and have
 * it take effect within one minute — without restarting the daemon.
 *
 * ## State file (`{dataDir}/calendar-sync-state.json`)
 *
 * ```json
 * {
 *   "lastSyncTimestamp": 1710000000000,
 *   "signalledEvents": {
 *     "eventId1": { "lastSignalledAt": 1710000000000, "hadMoreThan30MinRemaining": true }
 *   },
 *   "remindedEventIds": ["eventId1"]
 * }
 * ```
 *
 * ## Signal tiers
 *
 * | Condition                                    | Action                          |
 * |----------------------------------------------|---------------------------------|
 * | Event is 2–12 hours away                     | `sendSignal("calendar_event")`  |
 * | Event is < 30 minutes away (first time)      | `sendMessage("calendar_reminder")` |
 * | Event crosses the >30 min → <30 min boundary | Re-emit `sendSignal` once       |
 *
 * ## Deduplication window
 *
 * A `sendSignal` call for a given event is skipped if the event was already
 * signalled within `max(calendarSyncInterval * 2, 30)` minutes.
 * **Exception:** if the event previously had more than 30 minutes remaining
 * when it was last signalled but now has fewer than 30 minutes remaining, the
 * signal is re-emitted regardless of the dedup window (proximity threshold
 * crossing).
 *
 * ## Reminder deduplication
 *
 * `sendMessage("calendar_reminder")` fires **exactly once** per event.
 * Fired event IDs are recorded in `remindedEventIds` to prevent duplicate
 * chat messages across ticks.
 *
 * ## All-day events
 *
 * All-day events (where `CalendarEvent.allDay === true`) do not have a
 * specific start time and are therefore skipped for both signals and chat
 * reminders.  They will not appear in the `signalledEvents` or
 * `remindedEventIds` maps.
 *
 * ## Dependency injection
 *
 * Call {@link initCalendarSync} once from `daemon.ts`, passing the SDK's
 * `sendSignal` and `sendMessage` functions.  This avoids a hard dependency on
 * the SDK import path inside this module and keeps
 * `deno check sync/calendar-sync.ts` clean.
 *
 * @module
 */

import { getDataDir } from "../lib/data-dir.ts";
import { listCalendars, listEvents } from "../google/calendar.ts";
import { getAccessToken } from "../google/auth.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the state JSON file inside the data directory. */
const STATE_FILENAME = "calendar-sync-state.json";

/** Name of the shared settings JSON file inside the data directory. */
const SETTINGS_FILENAME = "settings.json";

/**
 * Default value for the `calendarSyncEnabled` setting.
 *
 * Calendar sync is enabled out of the box; users can disable it in the
 * settings panel.
 */
const DEFAULT_CALENDAR_SYNC_ENABLED = true;

/**
 * Default sync interval in minutes used when `settings.json` is absent or
 * does not contain a valid `calendarSyncInterval` value.
 */
const DEFAULT_CALENDAR_SYNC_INTERVAL = 5;

/**
 * How many days ahead to look when querying events in each tick.
 *
 * Querying 7 days ensures that events with a 2–12 hour lookahead window are
 * always captured, even when the daemon is restarted close to end-of-day.
 */
const LOOKAHEAD_DAYS = 7;

/**
 * Lower bound (inclusive) of the "2-hour" activation tier, in minutes.
 *
 * Events starting in this many minutes or more (up to {@link SIGNAL_MAX_MINUTES})
 * trigger a `sendSignal("calendar_event")` call.
 */
const SIGNAL_MIN_MINUTES = 120; // 2 hours

/**
 * Upper bound (inclusive) of the "12-hour" activation tier, in minutes.
 *
 * Events starting in more than this many minutes are outside the signal
 * window and are ignored until a later tick.
 */
const SIGNAL_MAX_MINUTES = 720; // 12 hours

/**
 * The proximity threshold in minutes.
 *
 * Events starting within this many minutes trigger a one-time chat reminder
 * via `sendMessage()` and cause a re-signal if the event was previously
 * signalled with more than this many minutes remaining.
 */
const REMINDER_THRESHOLD_MINUTES = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-event signal tracking record stored inside {@link CalendarSyncState}.
 *
 * Tracks when the event was last signalled and whether it had more than
 * {@link REMINDER_THRESHOLD_MINUTES} minutes remaining at that point, so
 * that proximity-threshold crossings can be detected in subsequent ticks.
 */
interface SignalledEventRecord {
  /** Unix millisecond timestamp of the last `sendSignal` call for this event. */
  lastSignalledAt: number;
  /**
   * `true` when the event had more than {@link REMINDER_THRESHOLD_MINUTES}
   * minutes remaining when it was last signalled.
   *
   * Used to detect proximity threshold crossings: if this is `true` but the
   * current `minutesUntil` is below the threshold, a re-signal is triggered.
   */
  hadMoreThan30MinRemaining: boolean;
}

/**
 * Shape of the JSON persisted to `{dataDir}/calendar-sync-state.json`.
 *
 * - `lastSyncTimestamp` — Unix ms timestamp of the last completed sync.
 *   Used by the self-throttle to avoid unnecessary API calls.
 * - `signalledEvents` — Map of event IDs to their last signal metadata.
 *   Used for deduplication and proximity-threshold detection.
 * - `remindedEventIds` — IDs of events for which a chat reminder has been
 *   sent.  Once an ID is in this list, no further `sendMessage` calls are
 *   made for that event.
 */
interface CalendarSyncState {
  /** Unix millisecond timestamp of the last completed sync. */
  lastSyncTimestamp: number;
  /**
   * Map of event ID → last signal record.
   *
   * Entries are added or updated each time `sendSignal` is called for an
   * event.  Old entries for past events are not pruned (state file is
   * small in practice).
   */
  signalledEvents: Record<string, SignalledEventRecord>;
  /**
   * IDs of events for which a `calendar_reminder` chat message has already
   * been sent.  Prevents duplicate reminder messages across ticks.
   */
  remindedEventIds: string[];
}

/**
 * Calendar-sync subset of the user's settings, loaded from
 * `{dataDir}/settings.json`.
 */
export interface CalendarSyncSettings {
  /**
   * When `false` the calendar-sync tick returns immediately without fetching
   * events or emitting signals.
   */
  calendarSyncEnabled: boolean;
  /**
   * How often to sync, in **minutes**.  The tick uses this to self-throttle
   * against the 1-minute base poll registered in `daemon.ts`.
   */
  calendarSyncInterval: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Injected `sendSignal` function.  Set via {@link initCalendarSync} before
 * first use.  Defaults to a no-op so that unit tests and type checks don't
 * need to wire it.
 */
let _sendSignal: (
  topic: string,
  payload: Record<string, unknown>,
) => Promise<void> = async (
  _topic: string,
  _payload: Record<string, unknown>,
): Promise<void> => {};

/**
 * Injected `sendMessage` function.  Set via {@link initCalendarSync} before
 * first use.  Defaults to a no-op so that unit tests and type checks don't
 * need to wire it.
 */
let _sendMessage: (message: string, topic: string) => Promise<void> = async (
  _msg: string,
  _topic: string,
): Promise<void> => {};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Wire the SDK's `sendSignal` and `sendMessage` functions into this module.
 *
 * Must be called once from `daemon.ts` before `calendarSyncTick` is
 * registered as a poll handler.  Subsequent calls replace both functions
 * (useful in tests).
 *
 * @param sendSignalFn  - The SDK-provided `sendSignal(topic, payload)` function.
 * @param sendMessageFn - The SDK-provided `sendMessage(message, topic)` function.
 *
 * @example
 * import { sendSignal, sendMessage } from "chalie:sdk";
 * import { initCalendarSync } from "./sync/calendar-sync.ts";
 * initCalendarSync(sendSignal, sendMessage);
 */
export function initCalendarSync(
  sendSignalFn: (topic: string, payload: Record<string, unknown>) => Promise<void>,
  sendMessageFn: (message: string, topic: string) => Promise<void>,
): void {
  _sendSignal = sendSignalFn;
  _sendMessage = sendMessageFn;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the calendar sync state file.
 *
 * Re-evaluated on every call so that `getDataDir()` picks up any change to
 * `Deno.args` between invocations (important during tests).
 *
 * @returns Path string for `{dataDir}/calendar-sync-state.json`.
 */
function calendarSyncStatePath(): string {
  return `${getDataDir()}/${STATE_FILENAME}`;
}

/**
 * Resolve the absolute path to the shared settings file.
 *
 * @returns Path string for `{dataDir}/settings.json`.
 */
function settingsFilePath(): string {
  return `${getDataDir()}/${SETTINGS_FILENAME}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Load calendar-sync settings from `{dataDir}/settings.json`.
 *
 * If the file is absent, unreadable, or does not contain the expected fields,
 * sensible defaults are returned instead of throwing.  This makes the function
 * safe to call before the user has visited the settings panel.
 *
 * Defaults:
 * - `calendarSyncEnabled`  → `true`
 * - `calendarSyncInterval` → `5` (minutes)
 *
 * @returns A promise that resolves to the populated {@link CalendarSyncSettings}.
 *
 * @example
 * const settings = await loadSettings();
 * if (!settings.calendarSyncEnabled) return;
 */
export async function loadSettings(): Promise<CalendarSyncSettings> {
  try {
    const raw = await Deno.readTextFile(settingsFilePath());
    const data = JSON.parse(raw) as Record<string, unknown>;

    return {
      calendarSyncEnabled:
        typeof data.calendarSyncEnabled === "boolean"
          ? data.calendarSyncEnabled
          : DEFAULT_CALENDAR_SYNC_ENABLED,

      calendarSyncInterval:
        typeof data.calendarSyncInterval === "number" && data.calendarSyncInterval > 0
          ? data.calendarSyncInterval
          : DEFAULT_CALENDAR_SYNC_INTERVAL,
    };
  } catch {
    // File absent, empty, or malformed — return defaults.
    return {
      calendarSyncEnabled: DEFAULT_CALENDAR_SYNC_ENABLED,
      calendarSyncInterval: DEFAULT_CALENDAR_SYNC_INTERVAL,
    };
  }
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the calendar sync state file from disk.
 *
 * Returns a default empty state instead of `null` so callers never have to
 * handle missing fields.  An absent or corrupt state file is treated as a
 * clean slate (first run).
 *
 * @returns The parsed {@link CalendarSyncState}, or a freshly-initialised
 *          state object if the file does not exist or cannot be parsed.
 */
async function loadCalendarSyncState(): Promise<CalendarSyncState> {
  try {
    const raw = await Deno.readTextFile(calendarSyncStatePath());
    const parsed = JSON.parse(raw) as Partial<CalendarSyncState>;
    return {
      lastSyncTimestamp: parsed.lastSyncTimestamp ?? 0,
      signalledEvents: parsed.signalledEvents ?? {},
      remindedEventIds: Array.isArray(parsed.remindedEventIds) ? parsed.remindedEventIds : [],
    };
  } catch {
    // File absent or malformed — start fresh.
    return {
      lastSyncTimestamp: 0,
      signalledEvents: {},
      remindedEventIds: [],
    };
  }
}

/**
 * Serialize and persist the calendar sync state to
 * `{dataDir}/calendar-sync-state.json`.
 *
 * Creates the data directory if it does not yet exist.
 *
 * @param state - The state object to persist.
 */
async function saveCalendarSyncState(state: CalendarSyncState): Promise<void> {
  await Deno.mkdir(getDataDir(), { recursive: true });
  await Deno.writeTextFile(
    calendarSyncStatePath(),
    JSON.stringify(state, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Compute how many minutes until the given ISO datetime string.
 *
 * Parses `isoString` via `new Date()`.  For timed events (RFC 3339 strings
 * such as `"2026-03-18T14:00:00-05:00"`), `new Date()` parses correctly.
 * Negative values mean the event is in the past.
 *
 * @param isoString - ISO 8601 / RFC 3339 datetime string for the event start.
 * @param nowMs     - Current time as Unix milliseconds (defaults to `Date.now()`).
 * @returns Minutes until the event starts (may be negative for past events).
 */
function minutesUntilStart(isoString: string, nowMs: number = Date.now()): number {
  const startMs = new Date(isoString).getTime();
  return (startMs - nowMs) / 60_000;
}

/**
 * Return an RFC 3339 timestamp string for the given Unix millisecond value.
 *
 * Used to build `timeMin` / `timeMax` query parameters for the Calendar API.
 *
 * @param ms - Unix milliseconds to convert.
 * @returns An RFC 3339 string (e.g. `"2026-03-18T14:00:00.000Z"`).
 */
function msToRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an event in the 2–12 hour range should have a
 * `sendSignal` emitted, based on the deduplication window and the
 * proximity threshold crossing logic.
 *
 * Deduplication rules:
 * 1. If the event has **never** been signalled → signal it.
 * 2. If the event was last signalled **outside** the dedup window → signal.
 * 3. If the event **crosses the proximity threshold** (was >30 min when last
 *    signalled, now <30 min) → signal regardless of the dedup window.
 * 4. Otherwise → skip.
 *
 * @param eventId          - Unique Google Calendar event ID.
 * @param minutesUntil     - Minutes until the event starts (may be < 0).
 * @param signalledEvents  - Current map of event ID → last signal record.
 * @param dedupWindowMs    - Deduplication window in milliseconds:
 *                           `max(calendarSyncInterval * 2, 30) * 60_000`.
 * @param nowMs            - Current time as Unix milliseconds.
 * @returns `true` if a signal should be emitted for this event.
 */
function shouldSignalEvent(
  eventId: string,
  minutesUntil: number,
  signalledEvents: Record<string, SignalledEventRecord>,
  dedupWindowMs: number,
  nowMs: number,
): boolean {
  const record = signalledEvents[eventId];

  // Never signalled before → always signal.
  if (!record) return true;

  // Proximity threshold crossing: was >30 min, now <30 min → re-signal.
  if (record.hadMoreThan30MinRemaining && minutesUntil < REMINDER_THRESHOLD_MINUTES) {
    return true;
  }

  // Outside dedup window → signal again.
  if (nowMs - record.lastSignalledAt >= dedupWindowMs) return true;

  // Within dedup window and no threshold crossing → skip.
  return false;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * Poll Google Calendar for upcoming events and emit signals / reminders.
 *
 * This function is designed to be registered as a 1-minute poll in
 * `daemon.ts`.  It implements its own self-throttle based on
 * `settings.calendarSyncInterval` so that the user-configured interval is
 * respected without needing to restart the daemon.
 *
 * ### Execution flow
 *
 * 1. Load settings; return early if `calendarSyncEnabled` is `false`.
 * 2. Load state from disk.
 * 3. **Self-throttle:** if fewer than `calendarSyncInterval` minutes have
 *    elapsed since `lastSyncTimestamp`, return early.
 * 4. Obtain a fresh access token via {@link getAccessToken}.
 * 5. Fetch all user calendars, then fetch events for the next
 *    {@link LOOKAHEAD_DAYS} days from each calendar.
 * 6. For each **timed** (non-all-day) event:
 *    - If the event is **< {@link REMINDER_THRESHOLD_MINUTES} minutes away**:
 *      - Send a `"calendar_reminder"` chat message via `sendMessage()` if the
 *        event is not already in `remindedEventIds` (fires exactly once).
 *      - Re-emit a `"calendar_event"` signal if the proximity threshold was
 *        just crossed (event was >30 min when last signalled, now <30 min).
 *    - If the event is **{@link SIGNAL_MIN_MINUTES}–{@link SIGNAL_MAX_MINUTES}
 *      minutes away** (2–12 hours):
 *      - Emit a `"calendar_event"` signal unless the deduplication window
 *        `max(calendarSyncInterval * 2, 30)` minutes has not elapsed since
 *        the last signal for this event.
 * 7. Persist the updated state to disk.
 *
 * ### Signal payload (`"calendar_event"`)
 *
 * ```json
 * {
 *   "id": "...",
 *   "summary": "Team Sync",
 *   "start": "2026-03-18T14:00:00-05:00",
 *   "end": "2026-03-18T15:00:00-05:00",
 *   "location": "https://meet.google.com/...",
 *   "calendarId": "primary",
 *   "minutesUntil": 95
 * }
 * ```
 *
 * ### Chat reminder message (`"calendar_reminder"`)
 *
 * ```
 * You have a meeting starting in 12 minutes: "Team Sync" at https://meet.google.com/...
 * ```
 *
 * @returns A promise that resolves when the tick completes (or was throttled
 *          and returned early).
 *
 * @throws {AuthError}       If the access token cannot be obtained or is
 *                           revoked.  The error propagates to the poll
 *                           scheduler and is logged by the SDK.
 * @throws {RateLimitError}  If the Calendar API rate limit is exceeded.
 * @throws {GoogleApiError}  For other non-OK Calendar API responses.
 *
 * @example
 * // Registered in daemon.ts as a 1-minute poll:
 * polls: [
 *   { name: "calendar-sync", every: minutes(1), run: calendarSyncTick },
 * ]
 */
export async function calendarSyncTick(): Promise<void> {
  // ── 1. Settings check ──────────────────────────────────────────────────────
  const settings = await loadSettings();
  if (!settings.calendarSyncEnabled) return;

  // ── 2. Load persisted state ────────────────────────────────────────────────
  const state = await loadCalendarSyncState();

  // ── 3. Self-throttle ───────────────────────────────────────────────────────
  // On the very first run (lastSyncTimestamp === 0), always proceed so that
  // the initial state is populated and reminders are armed for imminent events.
  if (state.lastSyncTimestamp !== 0) {
    const elapsed = Date.now() - state.lastSyncTimestamp;
    const intervalMs = settings.calendarSyncInterval * 60_000;
    if (elapsed < intervalMs) return;
  }

  // ── 4. Obtain access token ─────────────────────────────────────────────────
  const token = await getAccessToken();

  // ── 5. Fetch calendars + events for the next LOOKAHEAD_DAYS ───────────────
  const nowMs = Date.now();
  const timeMin = msToRfc3339(nowMs);
  const timeMax = msToRfc3339(nowMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  const calendars = await listCalendars(token);

  // Compute the deduplication window once; reused for every event.
  const dedupWindowMs = Math.max(settings.calendarSyncInterval * 2, 30) * 60_000;

  // Work on mutable copies of the state fields.
  const signalledEvents: Record<string, SignalledEventRecord> = {
    ...state.signalledEvents,
  };
  let remindedEventIds: string[] = [...state.remindedEventIds];

  // ── 6. Process events ──────────────────────────────────────────────────────
  for (const calendar of calendars) {
    let events;
    try {
      events = await listEvents(token, calendar.id, timeMin, timeMax);
    } catch {
      // If a single calendar fails (e.g. shared calendar removed), continue
      // with the remaining calendars rather than aborting the whole tick.
      continue;
    }

    for (const event of events) {
      // Skip all-day events — they have no specific start time and therefore
      // cannot produce meaningful "minutes until" values for reminders.
      if (event.allDay) continue;

      const minutesUntil = minutesUntilStart(event.start, nowMs);

      // Skip past events (should not happen given timeMin, but guard anyway).
      if (minutesUntil < 0) continue;

      // ── < REMINDER_THRESHOLD_MINUTES (< 30 min) ───────────────────────────
      if (minutesUntil < REMINDER_THRESHOLD_MINUTES) {
        // Send a one-time chat reminder if not already sent for this event.
        if (!remindedEventIds.includes(event.id)) {
          const roundedMinutes = Math.round(minutesUntil);
          let reminderText =
            `You have a meeting starting in ${roundedMinutes} minute${roundedMinutes !== 1 ? "s" : ""}: ` +
            `"${event.summary}"`;
          if (event.location) reminderText += ` at ${event.location}`;
          if (event.htmlLink) reminderText += ` — ${event.htmlLink}`;

          await _sendMessage(reminderText, "calendar_reminder");
          remindedEventIds = [...remindedEventIds, event.id];
        }

        // Proximity threshold crossing: re-signal if event was >30 min when
        // last signalled but has now crossed under the threshold.
        if (shouldSignalEvent(event.id, minutesUntil, signalledEvents, dedupWindowMs, nowMs)) {
          await _sendSignal("calendar_event", buildSignalPayload(event, minutesUntil));
          signalledEvents[event.id] = {
            lastSignalledAt: nowMs,
            hadMoreThan30MinRemaining: false,
          };
        }

        continue;
      }

      // ── SIGNAL_MIN_MINUTES–SIGNAL_MAX_MINUTES (2–12 hours) ────────────────
      if (minutesUntil >= SIGNAL_MIN_MINUTES && minutesUntil <= SIGNAL_MAX_MINUTES) {
        if (shouldSignalEvent(event.id, minutesUntil, signalledEvents, dedupWindowMs, nowMs)) {
          await _sendSignal("calendar_event", buildSignalPayload(event, minutesUntil));
          signalledEvents[event.id] = {
            lastSignalledAt: nowMs,
            hadMoreThan30MinRemaining: true,
          };
        }
      }
      // Events with 30–120 min remaining are intentionally outside both tiers.
      // They will be picked up by the <30-min tier in a later tick.
    }
  }

  // ── 7. Persist updated state ───────────────────────────────────────────────
  await saveCalendarSyncState({
    lastSyncTimestamp: nowMs,
    signalledEvents,
    remindedEventIds,
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the signal payload object for a `"calendar_event"` signal.
 *
 * Includes only defined optional fields (`location`, `htmlLink`) to keep the
 * payload compact.
 *
 * @param event        - The {@link CalendarEvent} to include in the payload.
 * @param minutesUntil - Pre-computed minutes until the event starts.
 * @returns A plain object suitable for passing to `sendSignal`.
 */
function buildSignalPayload(
  event: {
    id: string;
    summary: string;
    start: string;
    end: string;
    location?: string;
    htmlLink?: string;
    calendarId: string;
  },
  minutesUntil: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    calendarId: event.calendarId,
    minutesUntil: Math.round(minutesUntil),
  };

  if (event.location !== undefined) payload.location = event.location;
  if (event.htmlLink !== undefined) payload.htmlLink = event.htmlLink;

  return payload;
}
