/**
 * Email polling tick for the Chalie Google Interface daemon.
 *
 * Implements a self-throttled polling strategy: the daemon registers this
 * module's tick function against a 1-minute base interval, but the tick
 * checks `settings.emailSyncInterval` itself before doing any work.  This
 * allows users to change the sync interval from the settings panel and have
 * it take effect within one minute — without restarting the daemon.
 *
 * ## State file (`{dataDir}/email-sync-state.json`)
 *
 * ```json
 * {
 *   "lastSyncTimestamp": 1710000000000,
 *   "seenMessageIds": ["msg1", "msg2", ...]
 * }
 * ```
 *
 * ## First-run behaviour
 *
 * When no state file is found (first run or after the file was deleted), the
 * tick fetches the latest 20 inbox messages and marks them all as seen
 * **without emitting any signals**.  This prevents flooding the world state
 * with historical emails on initial setup.
 *
 * ## seenMessageIds cap
 *
 * The ID list is capped at {@link MAX_SEEN_IDS} (500) entries.  When the cap
 * is exceeded, the oldest entries (lowest array indices) are evicted, keeping
 * the most-recently-seen IDs.  This bounds the state file to a predictable
 * size while ensuring recent messages are reliably deduplicated.
 *
 * ## Dependency injection
 *
 * Call {@link initEmailSync} once from `daemon.ts`, passing the SDK's
 * `sendSignal` function.  This avoids a hard dependency on the SDK import
 * path inside this module and keeps `deno check sync/email-sync.ts` clean.
 *
 * @module
 */

import { getDataDir } from "../lib/data-dir.ts";
import { listMessages } from "../google/gmail.ts";
import { getAccessToken } from "../google/auth.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the state JSON file inside the data directory. */
const STATE_FILENAME = "email-sync-state.json";

/** Name of the shared settings JSON file inside the data directory. */
const SETTINGS_FILENAME = "settings.json";

/**
 * Default value for the `emailSyncEnabled` setting.
 *
 * Email sync is enabled out of the box; users can disable it in the settings
 * panel.
 */
const DEFAULT_EMAIL_SYNC_ENABLED = true;

/**
 * Default sync interval in minutes used when `settings.json` is absent or
 * does not contain a valid `emailSyncInterval` value.
 */
const DEFAULT_EMAIL_SYNC_INTERVAL = 5;

/**
 * Maximum number of message IDs stored in `seenMessageIds`.
 *
 * When this limit is exceeded the oldest entries (index 0) are evicted so
 * that the array never grows unboundedly.
 */
const MAX_SEEN_IDS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON persisted to `{dataDir}/email-sync-state.json`.
 *
 * `lastSyncTimestamp` records the Unix millisecond timestamp of the most
 * recent completed sync.  The tick uses this to implement the self-throttle.
 *
 * `seenMessageIds` is a capped FIFO list of Gmail message IDs that have
 * already been signalled (or were present on first run).
 */
interface EmailSyncState {
  /** Unix millisecond timestamp of the last completed sync. */
  lastSyncTimestamp: number;
  /**
   * List of Gmail message IDs that have been seen.
   *
   * Stored in insertion order (oldest entry at index 0).  Capped at
   * {@link MAX_SEEN_IDS} entries.
   */
  seenMessageIds: string[];
}

/**
 * Email-sync subset of the user's settings, loaded from
 * `{dataDir}/settings.json`.
 */
export interface EmailSyncSettings {
  /**
   * When `false` the email-sync tick returns immediately without fetching
   * messages or emitting signals.
   */
  emailSyncEnabled: boolean;
  /**
   * How often to sync, in **minutes**.  The tick uses this to self-throttle
   * against the 1-minute base poll registered in `daemon.ts`.
   */
  emailSyncInterval: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Injected `sendSignal` function.  Set via {@link initEmailSync} before first
 * use.  Defaults to a no-op so that unit tests and type checks don't need to
 * wire it.
 */
let _sendSignal: (
  topic: string,
  payload: Record<string, unknown>,
) => Promise<void> = async (
  _topic: string,
  _payload: Record<string, unknown>,
): Promise<void> => {};

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Wire the SDK's `sendSignal` function into this module.
 *
 * Must be called once from `daemon.ts` before `emailSyncTick` is registered
 * as a poll handler.  Subsequent calls replace the function (useful in tests).
 *
 * @param sendSignalFn - The SDK-provided `sendSignal(topic, payload)` function.
 *
 * @example
 * import { sendSignal } from "chalie:sdk";
 * import { initEmailSync } from "./sync/email-sync.ts";
 * initEmailSync(sendSignal);
 */
export function initEmailSync(
  sendSignalFn: (topic: string, payload: Record<string, unknown>) => Promise<void>,
): void {
  _sendSignal = sendSignalFn;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the email sync state file.
 *
 * Re-evaluated on every call so that `getDataDir()` picks up any change to
 * `Deno.args` between invocations (important during tests).
 *
 * @returns Path string for `{dataDir}/email-sync-state.json`.
 */
function emailSyncStatePath(): string {
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
 * Load email-sync settings from `{dataDir}/settings.json`.
 *
 * If the file is absent, unreadable, or does not contain the expected fields,
 * sensible defaults are returned instead of throwing.  This makes the function
 * safe to call before the user has visited the settings panel.
 *
 * Defaults:
 * - `emailSyncEnabled` → `true`
 * - `emailSyncInterval` → `5` (minutes)
 *
 * @returns A promise that resolves to the populated {@link EmailSyncSettings}.
 *
 * @example
 * const settings = await loadSettings();
 * if (!settings.emailSyncEnabled) return;
 */
export async function loadSettings(): Promise<EmailSyncSettings> {
  try {
    const raw = await Deno.readTextFile(settingsFilePath());
    const data = JSON.parse(raw) as Record<string, unknown>;

    return {
      emailSyncEnabled:
        typeof data.emailSyncEnabled === "boolean"
          ? data.emailSyncEnabled
          : DEFAULT_EMAIL_SYNC_ENABLED,

      emailSyncInterval:
        typeof data.emailSyncInterval === "number" && data.emailSyncInterval > 0
          ? data.emailSyncInterval
          : DEFAULT_EMAIL_SYNC_INTERVAL,
    };
  } catch {
    // File absent, empty, or malformed — return defaults.
    return {
      emailSyncEnabled: DEFAULT_EMAIL_SYNC_ENABLED,
      emailSyncInterval: DEFAULT_EMAIL_SYNC_INTERVAL,
    };
  }
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the email sync state file from disk.
 *
 * @returns The parsed {@link EmailSyncState}, or `null` if the file does not
 *          exist or cannot be parsed (i.e. first run).
 */
async function loadEmailSyncState(): Promise<EmailSyncState | null> {
  try {
    const raw = await Deno.readTextFile(emailSyncStatePath());
    return JSON.parse(raw) as EmailSyncState;
  } catch {
    return null;
  }
}

/**
 * Serialize and persist the email sync state to
 * `{dataDir}/email-sync-state.json`.
 *
 * Creates the data directory if it does not yet exist.
 *
 * @param state - The state object to persist.
 */
async function saveEmailSyncState(state: EmailSyncState): Promise<void> {
  await Deno.mkdir(getDataDir(), { recursive: true });
  await Deno.writeTextFile(
    emailSyncStatePath(),
    JSON.stringify(state, null, 2),
  );
}

// ---------------------------------------------------------------------------
// seenMessageIds helpers
// ---------------------------------------------------------------------------

/**
 * Append a message ID to the seen-IDs list, evicting the oldest entry if the
 * list would exceed {@link MAX_SEEN_IDS}.
 *
 * Insertion order is maintained: the oldest IDs are at the lowest indices.
 * If `id` is already present in `ids` it is not added again (no duplicates).
 *
 * @param ids - Current list of seen message IDs (oldest first).
 * @param id  - The new message ID to record.
 * @returns A new array with `id` appended (and the oldest entry removed if
 *          the cap was exceeded).
 */
function addToSeen(ids: string[], id: string): string[] {
  // Skip duplicates — the ID is already recorded.
  if (ids.includes(id)) return ids;

  const next = [...ids, id];

  // Evict oldest entries (front of the array) when over the cap.
  return next.length > MAX_SEEN_IDS ? next.slice(next.length - MAX_SEEN_IDS) : next;
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * Poll Gmail for new inbox messages and emit signals for unseen arrivals.
 *
 * This function is designed to be registered as a 1-minute poll in
 * `daemon.ts`.  It implements its own self-throttle based on
 * `settings.emailSyncInterval` so that the user-configured interval is
 * respected without needing to restart the daemon.
 *
 * ### Execution flow
 *
 * 1. Load settings; return early if `emailSyncEnabled` is `false`.
 * 2. Load state from disk.
 * 3. **Self-throttle:** if the state file exists and fewer than
 *    `emailSyncInterval` minutes have elapsed since `lastSyncTimestamp`,
 *    return early without making any API calls.
 * 4. Obtain a fresh access token via {@link getAccessToken}.
 * 5. Fetch the 20 most-recent inbox messages via {@link listMessages}.
 * 6. **First run** (no state file): mark all fetched IDs as seen without
 *    emitting any signals.  This avoids flooding the world state with
 *    historical emails on initial setup.
 * 7. **Subsequent runs**: for each message whose ID is not in `seenMessageIds`,
 *    emit an `email_received` signal and add the ID to the seen set.
 * 8. Persist the updated state (new `lastSyncTimestamp` + updated
 *    `seenMessageIds`) to disk.
 *
 * ### Signal payload
 *
 * ```json
 * {
 *   "id": "...",
 *   "from": "Alice <alice@example.com>",
 *   "subject": "Re: Meeting notes",
 *   "date": "Wed, 18 Mar 2026 10:00:00 +0000",
 *   "snippet": "Here are the notes from today's meeting...",
 *   "labels": ["INBOX", "UNREAD"],
 *   "isUnread": true
 * }
 * ```
 *
 * @returns A promise that resolves when the tick completes (or was throttled
 *          and returned early).
 *
 * @throws {AuthError}       If the access token cannot be obtained or is
 *                           revoked.  The error propagates to the poll
 *                           scheduler and is logged by the SDK.
 * @throws {RateLimitError}  If the Gmail API rate limit is exceeded.
 * @throws {GoogleApiError}  For other non-OK Gmail API responses.
 *
 * @example
 * // Registered in daemon.ts as a 1-minute poll:
 * polls: [
 *   { name: "email-sync", every: minutes(1), run: emailSyncTick },
 * ]
 */
export async function emailSyncTick(): Promise<void> {
  // ── 1. Settings check ──────────────────────────────────────────────────────
  const settings = await loadSettings();
  if (!settings.emailSyncEnabled) return;

  // ── 2. Load persisted state ────────────────────────────────────────────────
  const state = await loadEmailSyncState();
  const isFirstRun = state === null;

  // ── 3. Self-throttle ───────────────────────────────────────────────────────
  // Only skip if this is NOT a first run — on first run we always proceed so
  // that pre-existing messages are marked as seen.
  if (!isFirstRun) {
    const elapsed = Date.now() - state.lastSyncTimestamp;
    const intervalMs = settings.emailSyncInterval * 60_000;
    if (elapsed < intervalMs) return;
  }

  // ── 4. Obtain access token ─────────────────────────────────────────────────
  const token = await getAccessToken();

  // ── 5. Fetch recent inbox messages ─────────────────────────────────────────
  const messages = await listMessages(token, "in:inbox", 20);

  // ── 6 & 7. Process messages ────────────────────────────────────────────────
  const currentIds = state?.seenMessageIds ?? [];
  const seenSet = new Set(currentIds);
  let updatedIds = [...currentIds];

  if (isFirstRun) {
    // First run: mark all fetched messages as seen WITHOUT emitting signals.
    // This prevents historical emails from flooding the world state on first
    // setup.
    for (const msg of messages) {
      updatedIds = addToSeen(updatedIds, msg.id);
    }
  } else {
    // Subsequent runs: signal only messages we have not seen before.
    for (const msg of messages) {
      if (!seenSet.has(msg.id)) {
        await _sendSignal("email_received", {
          id: msg.id,
          from: msg.from,
          subject: msg.subject,
          date: msg.date,
          snippet: msg.snippet,
          labels: msg.labels,
          isUnread: msg.isUnread,
        });
        updatedIds = addToSeen(updatedIds, msg.id);
      }
    }
  }

  // ── 8. Persist updated state ───────────────────────────────────────────────
  await saveEmailSyncState({
    lastSyncTimestamp: Date.now(),
    seenMessageIds: updatedIds,
  });
}
