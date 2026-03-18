/**
 * Shared HTTP utilities for all Google REST API clients.
 *
 * Provides a single `googleFetch<T>()` helper that:
 *   - Attaches the `Authorization: Bearer <token>` header to every request.
 *   - Maps HTTP error status codes to typed error classes so callers can
 *     distinguish authentication failures from rate-limit errors and general
 *     API errors without inspecting raw HTTP status codes.
 *
 * ## Error hierarchy
 *
 * ```
 * Error
 * └── GoogleApiError   (non-OK response, status code + body text)
 *     ├── AuthError    (HTTP 401 — token expired or revoked)
 *     └── RateLimitError (HTTP 429 — per-user quota exhausted)
 * ```
 *
 * All callers (`gmail.ts`, `calendar.ts`, `auth.ts`) should use
 * `googleFetch` rather than calling `fetch` directly, so that error
 * handling stays in one place.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Raised for any non-OK response from a Google API endpoint.
 *
 * Carries the HTTP status code and the raw response body so that the
 * `executeCommand()` dispatcher can log or surface meaningful details.
 *
 * @example
 * try {
 *   await googleFetch<MyType>(url, token);
 * } catch (e) {
 *   if (e instanceof GoogleApiError) console.error(e.status, e.message);
 * }
 */
export class GoogleApiError extends Error {
  /** HTTP status code returned by the Google API. */
  readonly status: number;

  /**
   * @param message - Human-readable description including status and body.
   * @param status  - The HTTP status code (e.g. 403, 500).
   */
  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

/**
 * Raised when a Google API request returns HTTP 401.
 *
 * Indicates that the stored access token has expired or the user has revoked
 * access. The caller should attempt a token refresh; if that also fails it
 * should clear stored credentials and surface an `auth_error` message.
 *
 * Extends {@link GoogleApiError} so catch blocks that handle the base class
 * continue to work without modification.
 *
 * @example
 * if (e instanceof AuthError) {
 *   await clearCredentials();
 *   await sendMessage("Re-authorization needed.", "auth_error");
 * }
 */
export class AuthError extends GoogleApiError {
  /**
   * @param message - Optional override; defaults to a standard description.
   */
  constructor(message = "Google token expired or revoked (HTTP 401)") {
    super(message, 401);
    this.name = "AuthError";
  }
}

/**
 * Raised when a Google API request returns HTTP 429.
 *
 * Google's per-user quotas are fairly generous under normal usage, but batch
 * operations or rapid polling can exhaust them. The caller should surface a
 * friendly retry message rather than crashing.
 *
 * Extends {@link GoogleApiError} so catch blocks that handle the base class
 * continue to work without modification.
 *
 * @example
 * if (e instanceof RateLimitError) {
 *   return { error: "Google API rate limit reached. Try again in a minute." };
 * }
 */
export class RateLimitError extends GoogleApiError {
  /**
   * @param message - Optional override; defaults to a standard description.
   */
  constructor(message = "Google API rate limit hit (HTTP 429). Try again in a minute.") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

// ---------------------------------------------------------------------------
// googleFetch helper
// ---------------------------------------------------------------------------

/**
 * Perform an authenticated HTTP request against a Google API endpoint.
 *
 * Behaviour:
 * 1. Merges caller-supplied `options` with an `Authorization: Bearer <token>`
 *    header. If the caller also supplies an `Authorization` header it is
 *    **overwritten** — the token from the parameter always wins.
 * 2. Awaits the response:
 *    - **HTTP 401** → throws {@link AuthError}
 *    - **HTTP 429** → throws {@link RateLimitError}
 *    - **Any other non-2xx** → reads the response body as text and throws
 *      {@link GoogleApiError} containing the status code and body.
 * 3. On success (2xx) returns `res.json()` cast to `T`.
 *
 * @typeParam T - Expected shape of the JSON response body.
 *
 * @param url     - Fully-qualified Google API URL (including query parameters).
 * @param token   - A valid OAuth2 access token (no `Bearer` prefix needed).
 * @param options - Optional `fetch` init overrides (method, body, headers, …).
 *                  Do **not** include `Authorization` — it is set automatically.
 *
 * @returns A promise that resolves to the JSON-decoded response as type `T`.
 *
 * @throws {AuthError}       If the server returns HTTP 401.
 * @throws {RateLimitError}  If the server returns HTTP 429.
 * @throws {GoogleApiError}  If the server returns any other non-OK status.
 *
 * @example
 * // GET request
 * const profile = await googleFetch<UserInfo>(
 *   "https://www.googleapis.com/oauth2/v2/userinfo",
 *   accessToken,
 * );
 *
 * @example
 * // POST request with a JSON body
 * const event = await googleFetch<CalendarEvent>(
 *   "https://www.googleapis.com/calendar/v3/calendars/primary/events",
 *   accessToken,
 *   {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify(eventPayload),
 *   },
 * );
 */
export async function googleFetch<T>(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      // Spread any caller-supplied headers first, then overwrite Authorization
      // so the token parameter is always authoritative.
      ...(options?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    throw new AuthError();
  }

  if (response.status === 429) {
    throw new RateLimitError();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new GoogleApiError(
      `Google API error ${response.status}: ${body}`,
      response.status,
    );
  }

  return response.json() as Promise<T>;
}
