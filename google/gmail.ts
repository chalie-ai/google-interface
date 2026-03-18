/**
 * Gmail REST API client for the Chalie Google Interface daemon.
 *
 * Wraps the Gmail v1 REST API with typed helpers for the six operations Chalie
 * needs: listing messages, reading a message, creating drafts, moving messages
 * to a label, trashing messages, and listing labels.
 *
 * ## Design notes
 *
 * - All network requests go through {@link googleFetch} from `api-utils.ts`,
 *   which attaches the `Authorization` header and maps HTTP error codes to
 *   typed error classes (`AuthError`, `RateLimitError`, `GoogleApiError`).
 * - {@link listMessages} uses an N+1 fetch strategy: first fetch IDs via
 *   `messages.list`, then fetch each message's metadata individually using a
 *   `Promise.all` pool capped at five concurrent requests.
 * - {@link getMessage} decodes the base64url-encoded body, recursively walks
 *   `multipart/*` payloads to locate a `text/plain` part (or falls back to
 *   `text/html` with tag-stripping), and decodes bytes as UTF-8.
 * - HTML stripping is done with a plain regex — no external dependencies.
 *
 * // Intentionally no sendEmail — drafts only (safety constraint)
 *
 * @module
 */

import { googleFetch } from "./api-utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for all Gmail API v1 requests scoped to the authenticated user. */
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Maximum concurrent `messages.get` requests during batch metadata fetch. */
const BATCH_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Internal Google API shapes (raw response types)
// ---------------------------------------------------------------------------

/** A single item in the `messages.list` response. */
interface GmailMessageRef {
  id: string;
  threadId: string;
}

/** Top-level `messages.list` API response. */
interface GmailMessageListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** A single MIME part within a Gmail message payload. */
interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body: {
    attachmentId?: string;
    size: number;
    /** Base64url-encoded part data. Only present for leaf parts. */
    data?: string;
  };
  /** Nested parts present for `multipart/*` MIME types. */
  parts?: GmailMessagePart[];
}

/** Full message resource returned by `messages.get`. */
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload: GmailMessagePart;
  sizeEstimate?: number;
}

/** `drafts.create` response. */
interface GmailDraftCreateResponse {
  id: string;
  message: {
    id: string;
    threadId: string;
    labelIds?: string[];
  };
}

/** A single Gmail label from `labels.list`. */
interface GmailLabelRaw {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

/** `labels.list` API response. */
interface GmailLabelListResponse {
  labels: GmailLabelRaw[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Condensed summary of a Gmail message, suitable for displaying in a list.
 *
 * Produced by {@link listMessages}.  Does **not** include the full body —
 * call {@link getMessage} for that.
 */
export interface EmailSummary {
  /** Unique Gmail message ID. */
  id: string;
  /** Thread this message belongs to. */
  threadId: string;
  /** `From:` header value (display name + address). */
  from: string;
  /** `Subject:` header value. */
  subject: string;
  /** `Date:` header value as returned by Gmail (RFC 2822 format). */
  date: string;
  /** Short auto-generated snippet from the message body. */
  snippet: string;
  /** List of Gmail label IDs applied to this message (e.g. `"INBOX"`, `"UNREAD"`). */
  labels: string[];
  /** `true` when the `UNREAD` label is present. */
  isUnread: boolean;
}

/**
 * Full content of a Gmail message, extending {@link EmailSummary} with decoded
 * body and additional recipient headers.
 *
 * Produced by {@link getMessage}.
 */
export interface EmailDetail extends EmailSummary {
  /**
   * Plain-text body of the message.
   *
   * For `text/plain` parts this is the decoded content directly.  For
   * `text/html`-only messages the HTML tags are stripped via regex.
   * Returns an empty string when the body cannot be extracted.
   */
  body: string;
  /** `To:` header value. */
  to: string;
  /** `Cc:` header value, or `undefined` when not present. */
  cc?: string;
}

/**
 * A Gmail label as returned by {@link listLabels}.
 */
export interface Label {
  /** Unique label ID (e.g. `"INBOX"`, `"Label_123"`). */
  id: string;
  /** Human-readable label name. */
  name: string;
  /**
   * Label type: `"system"` for built-in labels (INBOX, SENT, …) or
   * `"user"` for user-created labels.
   */
  type: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64url-encoded string to a UTF-8 text string.
 *
 * Gmail encodes all message body data using base64url (RFC 4648 §5), which
 * uses `-` instead of `+` and `_` instead of `/`, and omits padding.  This
 * function normalises the encoding, calls `atob` to obtain a binary string,
 * then uses `TextDecoder` to interpret the bytes as UTF-8.
 *
 * @param data - Base64url-encoded string from the Gmail API `body.data` field.
 * @returns Decoded UTF-8 text, or an empty string if decoding fails.
 */
function decodeBase64url(data: string): string {
  try {
    // 1. Convert base64url alphabet to standard base64.
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    // 2. Re-add stripped padding.
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    // 3. atob → binary string (one char per byte).
    const binaryStr = atob(padded);
    // 4. Reinterpret bytes as UTF-8.
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

/**
 * Strip HTML tags and decode common HTML entities from a string.
 *
 * Used to convert an HTML email body to plain text when no `text/plain` MIME
 * part is available.  Handles `<style>` and `<script>` blocks separately to
 * avoid leaving their content as visible text.
 *
 * No external libraries are used — all processing is done with plain regexes.
 *
 * @param html - Raw HTML string.
 * @returns Approximate plain-text representation with excess whitespace collapsed.
 */
function stripHtmlTags(html: string): string {
  return html
    // Remove <style> blocks entirely (content is not readable text).
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Remove <script> blocks entirely.
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Convert <br> and block-level tags to newlines before stripping.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote)[^>]*>/gi, "\n")
    // Strip all remaining tags.
    .replace(/<[^>]+>/g, "")
    // Decode the five basic HTML entities.
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse runs of whitespace / blank lines.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Recursively search a MIME payload tree for a part with the given MIME type
 * and return its raw base64url-encoded body data.
 *
 * Performs a depth-first search through `payload.parts`, stopping at the first
 * match.  This correctly handles `multipart/mixed`, `multipart/alternative`,
 * and arbitrarily nested structures.
 *
 * @param part     - The MIME part (or message payload) to search within.
 * @param mimeType - The exact MIME type to look for (e.g. `"text/plain"`).
 * @returns The raw `body.data` string if found, otherwise `null`.
 */
function findBodyData(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }
  if (part.parts) {
    for (const subPart of part.parts) {
      const found = findBodyData(subPart, mimeType);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Extract and decode the best available plain-text body from a message payload.
 *
 * Preference order:
 * 1. `text/plain` part (decoded directly from base64url).
 * 2. `text/html` part (decoded then stripped of HTML tags).
 * 3. Empty string if neither is found.
 *
 * @param payload - The top-level MIME payload from a Gmail message.
 * @returns Decoded plain-text body string.
 */
function extractBodyText(payload: GmailMessagePart): string {
  // Prefer text/plain.
  const plainData = findBodyData(payload, "text/plain");
  if (plainData) {
    return decodeBase64url(plainData);
  }

  // Fall back to text/html with tag stripping.
  const htmlData = findBodyData(payload, "text/html");
  if (htmlData) {
    return stripHtmlTags(decodeBase64url(htmlData));
  }

  return "";
}

/**
 * Retrieve a named header value from a Gmail message headers array.
 *
 * Header matching is case-insensitive, consistent with RFC 2822.
 *
 * @param headers - Array of `{ name, value }` pairs from the Gmail API.
 * @param name    - Header name to look up (e.g. `"From"`, `"Subject"`).
 * @returns The header value, or an empty string if the header is absent.
 */
function getHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      ""
  );
}

/**
 * Process items in batches of `limit`, running each batch's items concurrently
 * via `Promise.all`, and collecting all results in order.
 *
 * This provides a simple concurrency cap without the complexity of a full
 * sliding-window scheduler.  Each batch of `limit` requests fires together;
 * the next batch waits until all requests in the current batch have resolved.
 *
 * @typeParam T - Type of each input item.
 * @typeParam R - Type of each mapped result.
 *
 * @param items       - Input array to process.
 * @param limit       - Maximum number of concurrent calls per batch (e.g. 5).
 * @param fn          - Async function applied to each item.
 * @returns Array of results in the same order as `items`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Build a minimal RFC 2822 email message and encode it as base64url, ready to
 * pass to the Gmail `drafts.create` API `message.raw` field.
 *
 * The message is encoded to bytes with `TextEncoder` so that non-ASCII
 * characters in the subject or body survive the base64 conversion correctly.
 *
 * @param to      - Recipient email address or display name + address.
 * @param subject - Email subject line.
 * @param body    - Plain-text email body.
 * @returns Base64url-encoded RFC 2822 message string.
 */
function buildRawEmail(to: string, subject: string, body: string): string {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");

  // Encode the full raw message to UTF-8 bytes then to base64url.
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Build an {@link EmailSummary} from a Gmail metadata-format message.
 *
 * @param msg - Gmail API message resource (format=metadata).
 * @returns A populated `EmailSummary`.
 */
function toEmailSummary(msg: GmailMessage): EmailSummary {
  const headers = msg.payload?.headers ?? [];
  const labels = msg.labelIds ?? [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet ?? "",
    labels,
    isUnread: labels.includes("UNREAD"),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List Gmail messages matching an optional search query.
 *
 * Uses an N+1 fetch strategy:
 * 1. `GET /messages?q=...&maxResults=...` — retrieves message IDs only.
 * 2. For each ID, `GET /messages/{id}?format=metadata&metadataHeaders=From,...`
 *    — retrieves only the headers needed to build an {@link EmailSummary}.
 *
 * The per-message metadata fetches are batched with a concurrency limit of
 * {@link BATCH_CONCURRENCY} to avoid exceeding Gmail's per-user quota.
 *
 * @param token      - Valid OAuth2 access token with the `gmail.modify` scope.
 * @param query      - Gmail search query (e.g. `"is:unread in:inbox"`).
 *                     Defaults to listing all messages.
 * @param maxResults - Maximum number of messages to return (1–500).
 *                     Defaults to 20.
 *
 * @returns Array of {@link EmailSummary} objects in the order returned by Gmail
 *          (newest first by default).  Returns an empty array when no messages
 *          match or the account has no messages.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const unread = await listMessages(token, "is:unread in:inbox", 10);
 */
export async function listMessages(
  token: string,
  query = "",
  maxResults = 20,
): Promise<EmailSummary[]> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
  });
  if (query) {
    params.set("q", query);
  }

  const listResponse = await googleFetch<GmailMessageListResponse>(
    `${GMAIL_BASE}/messages?${params.toString()}`,
    token,
  );

  const refs = listResponse.messages ?? [];
  if (refs.length === 0) return [];

  // Fetch metadata for each message ID — capped at BATCH_CONCURRENCY concurrent
  // requests to avoid exhausting per-user quota.
  const metadataParams = new URLSearchParams({
    format: "metadata",
    metadataHeaders: "From",
  });
  // URLSearchParams appends multiple values for the same key correctly.
  metadataParams.append("metadataHeaders", "Subject");
  metadataParams.append("metadataHeaders", "Date");

  const summaries = await mapWithConcurrency(
    refs,
    BATCH_CONCURRENCY,
    (ref) =>
      googleFetch<GmailMessage>(
        `${GMAIL_BASE}/messages/${ref.id}?${metadataParams.toString()}`,
        token,
      ).then(toEmailSummary),
  );

  return summaries;
}

/**
 * Fetch the full content of a single Gmail message.
 *
 * Downloads the complete message resource (`format=full`), decodes the body
 * via {@link extractBodyText} (which recursively walks `multipart/*` payloads),
 * and returns an {@link EmailDetail} containing the decoded plain-text body.
 *
 * @param token - Valid OAuth2 access token with the `gmail.modify` scope.
 * @param id    - Gmail message ID (e.g. from an {@link EmailSummary}).
 *
 * @returns A fully-populated {@link EmailDetail}.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const detail = await getMessage(token, emailSummary.id);
 * console.log(detail.body);
 */
export async function getMessage(token: string, id: string): Promise<EmailDetail> {
  const msg = await googleFetch<GmailMessage>(
    `${GMAIL_BASE}/messages/${id}?format=full`,
    token,
  );

  const headers = msg.payload?.headers ?? [];
  const labels = msg.labelIds ?? [];
  const cc = getHeader(headers, "Cc");

  const detail: EmailDetail = {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet ?? "",
    labels,
    isUnread: labels.includes("UNREAD"),
    body: extractBodyText(msg.payload),
  };

  if (cc) {
    detail.cc = cc;
  }

  return detail;
}

/**
 * Create a Gmail draft with the given recipient, subject, and plain-text body.
 *
 * The message is encoded to RFC 2822 format and then base64url-encoded before
 * being sent to the Gmail `drafts.create` endpoint.
 *
 * // Intentionally no sendEmail — drafts only (safety constraint)
 *
 * @param token   - Valid OAuth2 access token with the `gmail.compose` scope.
 * @param to      - Recipient email address (e.g. `"alice@example.com"` or
 *                  `"Alice Smith <alice@example.com>"`).
 * @param subject - Email subject line.
 * @param body    - Plain-text body of the draft.
 *
 * @returns The Gmail draft ID string (use this to retrieve or send the draft
 *          later via the API if needed).
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const draftId = await createDraft(token, "bob@example.com",
 *   "Meeting notes", "Hi Bob, here are the notes…");
 */
export async function createDraft(
  token: string,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  const raw = buildRawEmail(to, subject, body);

  const response = await googleFetch<GmailDraftCreateResponse>(
    `${GMAIL_BASE}/drafts`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    },
  );

  return response.id;
}

/**
 * Add a label to a Gmail message.
 *
 * Calls the `messages.modify` endpoint to append `labelId` to the message's
 * label set.  Existing labels are preserved.
 *
 * @param token     - Valid OAuth2 access token with the `gmail.modify` scope.
 * @param messageId - Gmail message ID.
 * @param labelId   - ID of the label to add (e.g. `"STARRED"`, `"Label_123"`).
 *
 * @returns A promise that resolves when the label has been applied.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * await moveTo(token, message.id, "STARRED");
 */
export async function moveTo(
  token: string,
  messageId: string,
  labelId: string,
): Promise<void> {
  await googleFetch<Record<string, unknown>>(
    `${GMAIL_BASE}/messages/${messageId}/modify`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    },
  );
}

/**
 * Move a Gmail message to the trash.
 *
 * The message is not permanently deleted — it remains in Trash for 30 days
 * and can be restored.  This is equivalent to the "Move to Trash" action in
 * the Gmail UI.
 *
 * @param token     - Valid OAuth2 access token with the `gmail.modify` scope.
 * @param messageId - Gmail message ID.
 *
 * @returns A promise that resolves when the message has been trashed.
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * await trashMessage(token, message.id);
 */
export async function trashMessage(token: string, messageId: string): Promise<void> {
  await googleFetch<Record<string, unknown>>(
    `${GMAIL_BASE}/messages/${messageId}/trash`,
    token,
    { method: "POST" },
  );
}

/**
 * Retrieve all labels defined in the user's Gmail account.
 *
 * Returns both system labels (INBOX, SENT, TRASH, etc.) and user-created
 * labels.  Label IDs returned here can be passed to {@link moveTo} to apply
 * them to messages.
 *
 * @param token - Valid OAuth2 access token with the `gmail.modify` scope.
 *
 * @returns Array of {@link Label} objects sorted by the Gmail API's default
 *          ordering (system labels first, then user labels alphabetically).
 *
 * @throws {AuthError}       If the token is expired or revoked (HTTP 401).
 * @throws {RateLimitError}  If the Gmail API rate limit is hit (HTTP 429).
 * @throws {GoogleApiError}  For other non-OK API responses.
 *
 * @example
 * const labels = await listLabels(token);
 * const inbox = labels.find(l => l.id === "INBOX");
 */
export async function listLabels(token: string): Promise<Label[]> {
  const response = await googleFetch<GmailLabelListResponse>(
    `${GMAIL_BASE}/labels`,
    token,
  );

  return (response.labels ?? []).map((raw) => ({
    id: raw.id,
    name: raw.name,
    type: raw.type ?? "user",
  }));
}
