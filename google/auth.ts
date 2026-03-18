/**
 * Google OAuth2 lifecycle management for the Chalie Google Interface daemon.
 *
 * Manages the complete OAuth2 authorization code flow:
 *   - Persisting client credentials and tokens to `{dataDir}/credentials.json`
 *   - Proactive access-token refresh (60 s before expiry)
 *   - Detecting and communicating token revocation (`invalid_grant`)
 *   - A self-contained temporary HTTP server on a configurable port that
 *     drives the browser-based consent flow from the setup wizard
 *
 * ## Token storage format
 * ```json
 * {
 *   "client_id":     "...",
 *   "client_secret": "...",
 *   "refresh_token": "...",
 *   "access_token":  "...",
 *   "expires_at":    1234567890123,
 *   "email":         "user@gmail.com"
 * }
 * ```
 *
 * ## OAuth scopes requested
 * - `https://www.googleapis.com/auth/gmail.modify`   (read, label, trash)
 * - `https://www.googleapis.com/auth/gmail.compose`  (drafts)
 * - `https://www.googleapis.com/auth/calendar`        (read + write events)
 * - `https://www.googleapis.com/auth/userinfo.email`  (identify the account)
 *
 * ## Dependency injection
 * Call {@link initAuth} once (from `daemon.ts`) before using
 * {@link getAccessToken}, passing the SDK's `sendMessage` function.  This
 * avoids a hard dependency on a specific SDK import path in this module and
 * keeps `deno check google/auth.ts` clean.
 *
 * @module
 */

import { getDataDir } from "../lib/data-dir.ts";
import { AuthError } from "./api-utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All OAuth2 scopes requested from Google. */
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

/** Google's token exchange / refresh endpoint. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google's OAuth2 consent page base URL. */
const AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's userinfo endpoint. */
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** Refresh the token this many milliseconds before it actually expires. */
const REFRESH_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the JSON persisted to `{dataDir}/credentials.json`.
 *
 * All fields except `client_id` and `client_secret` are optional because the
 * file may be written in two phases: credentials first, then tokens after the
 * OAuth callback.
 */
interface StoredCredentials {
  /** Google OAuth2 client ID. */
  client_id: string;
  /** Google OAuth2 client secret. */
  client_secret: string;
  /** Long-lived refresh token granted by the consent flow. */
  refresh_token?: string;
  /** Short-lived access token for API calls. */
  access_token?: string;
  /**
   * Absolute expiry timestamp as milliseconds since Unix epoch
   * (i.e. `Date.now() + expires_in * 1000`).
   */
  expires_at?: number;
  /** Cached email address of the authenticated account. */
  email?: string;
}

/** Response body from Google's token endpoint. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

/** Response body from Google's userinfo endpoint. */
interface UserInfoResponse {
  email: string;
  verified_email?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Injected `sendMessage` function.  Set via {@link initAuth} before first use.
 * Defaults to a no-op so that unit tests and type checks don't need to wire it.
 */
let _sendMessage: (message: string, topic: string) => Promise<void> = async (
  _msg: string,
  _topic: string,
): Promise<void> => {};

/** Active OAuth callback HTTP server, if running. */
let _callbackServer: Deno.HttpServer | null = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Wire the SDK's `sendMessage` function into this module.
 *
 * Must be called once from `daemon.ts` before any code path that triggers
 * {@link getAccessToken} on an expired or revoked token.  Subsequent calls
 * replace the function (useful for testing).
 *
 * @param sendMessageFn - The SDK-provided `sendMessage(message, topic)` function.
 *
 * @example
 * import { sendMessage } from "chalie:sdk";
 * import { initAuth } from "./google/auth.ts";
 * initAuth(sendMessage);
 */
export function initAuth(
  sendMessageFn: (message: string, topic: string) => Promise<void>,
): void {
  _sendMessage = sendMessageFn;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the credentials file.
 *
 * Re-evaluated on every call so that tests can change `Deno.args` between
 * invocations without stale paths.
 *
 * @returns Path string for `{dataDir}/credentials.json`.
 */
function credentialsPath(): string {
  return `${getDataDir()}/credentials.json`;
}

// ---------------------------------------------------------------------------
// Low-level read / write helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse `credentials.json` from disk.
 *
 * @returns Parsed credentials object, or `null` if the file does not exist or
 *          cannot be parsed.
 */
async function readCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await Deno.readTextFile(credentialsPath());
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

/**
 * Serialize and persist `credentials` to `{dataDir}/credentials.json`.
 *
 * Creates the data directory if it does not yet exist.
 *
 * @param credentials - The credentials object to persist.
 */
async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  await Deno.mkdir(getDataDir(), { recursive: true });
  await Deno.writeTextFile(
    credentialsPath(),
    JSON.stringify(credentials, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronously check whether the daemon has a complete, usable Google
 * authorization.
 *
 * "Configured" means `credentials.json` exists **and** contains a non-empty
 * `refresh_token`.  The presence of a refresh token is the definitive signal
 * that the OAuth consent flow completed successfully.
 *
 * This function is intentionally synchronous so that `renderInterface()` can
 * call it without `await` when deciding whether to show the setup wizard or
 * the main dashboard.
 *
 * @returns `true` if fully configured, `false` otherwise.
 *
 * @example
 * if (!isConfigured()) {
 *   return renderSetupWizard();
 * }
 */
export function isConfigured(): boolean {
  try {
    const raw = Deno.readTextFileSync(credentialsPath());
    const creds = JSON.parse(raw) as StoredCredentials;
    return typeof creds.refresh_token === "string" &&
      creds.refresh_token.length > 0;
  } catch {
    return false;
  }
}

/**
 * Return a valid Google API access token, refreshing it automatically if it
 * is within {@link REFRESH_BUFFER_MS} of expiry.
 *
 * ### Token-refresh failure handling
 * If Google rejects the refresh request with `"invalid_grant"` (meaning the
 * user revoked access or the token was invalidated), this function:
 *   1. Deletes `refresh_token` from the stored credentials so the daemon
 *      reverts to the "not configured" state.
 *   2. Sends an `auth_error` message to the user via the injected
 *      `sendMessage` function so that Chalie can surface it in the chat UI.
 *   3. Throws an {@link AuthError} so the caller can return a user-friendly
 *      error response instead of crashing.
 *
 * @returns A valid access token string (no `Bearer` prefix).
 *
 * @throws {AuthError} If credentials are missing, or the refresh token is
 *                     revoked / invalid.
 *
 * @example
 * const token = await getAccessToken();
 * const res = await googleFetch<GmailMessage>(url, token);
 */
export async function getAccessToken(): Promise<string> {
  const creds = await readCredentials();

  if (!creds?.refresh_token) {
    throw new AuthError(
      "No refresh token found. Please re-authorize in the Google interface settings.",
    );
  }

  const now = Date.now();
  const expiresAt = creds.expires_at ?? 0;

  // Return the cached access token if it is still fresh.
  if (creds.access_token && expiresAt - now > REFRESH_BUFFER_MS) {
    return creds.access_token;
  }

  // ── Token refresh ────────────────────────────────────────────────────────
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<
      string,
      unknown
    >;

    // "invalid_grant" means the refresh token has been revoked.
    if (errorBody?.error === "invalid_grant") {
      // Remove the stale refresh token so isConfigured() returns false.
      const cleaned: StoredCredentials = { ...creds };
      delete cleaned.refresh_token;
      delete cleaned.access_token;
      delete cleaned.expires_at;
      await writeCredentials(cleaned);

      // Notify the user through the Chalie chat interface.
      await _sendMessage(
        "Your Google connection has expired. Please re-authorize in the Google interface settings.",
        "auth_error",
      );

      throw new AuthError(
        "Google refresh token has been revoked (invalid_grant). Re-authorization required.",
      );
    }

    throw new AuthError(
      `Token refresh failed with HTTP ${res.status}: ${JSON.stringify(errorBody)}`,
    );
  }

  const tokenData = (await res.json()) as TokenResponse;

  // Persist the new access token (and update the refresh token if Google
  // rotated it, which happens for some account types).
  const updated: StoredCredentials = {
    ...creds,
    access_token: tokenData.access_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };
  if (tokenData.refresh_token) {
    updated.refresh_token = tokenData.refresh_token;
  }

  await writeCredentials(updated);

  return tokenData.access_token;
}

/**
 * Persist a Google OAuth2 client ID and secret to `credentials.json`.
 *
 * This is the first step of the setup flow.  The refresh and access tokens
 * are written later by {@link handleAuthCallback} once the user completes the
 * consent screen.
 *
 * Calling this function does **not** start the OAuth flow — use
 * {@link getAuthUrl} to build the consent URL, then direct the user there.
 *
 * @param clientId     - The OAuth2 client ID from Google Cloud Console.
 * @param clientSecret - The OAuth2 client secret from Google Cloud Console.
 *
 * @example
 * await saveCredentials("1234.apps.googleusercontent.com", "GOCSPX-...");
 */
export async function saveCredentials(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  // Preserve any tokens that may already be stored (e.g. re-saving client
  // details without revoking an existing session).
  const existing = await readCredentials();
  const credentials: StoredCredentials = {
    ...existing,
    client_id: clientId,
    client_secret: clientSecret,
  };
  await writeCredentials(credentials);
}

/**
 * Exchange an OAuth2 authorization code for access and refresh tokens, then
 * persist them together with the authenticated account's email address.
 *
 * Called by the OAuth callback server when Google redirects the user back to
 * `http://localhost:{port}/oauth/callback?code=...`.
 *
 * Token fields written to `credentials.json`:
 * - `refresh_token` — long-lived; used for all future token refreshes.
 * - `access_token`  — short-lived; used directly for API calls.
 * - `expires_at`    — `Date.now() + expires_in * 1000`.
 * - `email`         — fetched from the userinfo endpoint and cached.
 *
 * @param code        - Authorization code from Google's redirect query string.
 * @param clientId    - The same client ID used to build the consent URL.
 * @param clientSecret - The matching client secret.
 * @param redirectUri - Must exactly match the redirect URI registered in
 *                      Google Cloud Console (e.g. `http://localhost:9004/oauth/callback`).
 *
 * @throws {Error} If the token exchange HTTP request fails.
 *
 * @example
 * await handleAuthCallback(code, clientId, clientSecret,
 *   "http://localhost:9004/oauth/callback");
 */
export async function handleAuthCallback(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<void> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `Authorization code exchange failed (HTTP ${res.status}): ${errorText}`,
    );
  }

  const tokenData = (await res.json()) as TokenResponse;

  if (!tokenData.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Ensure the consent screen was shown " +
        "(add prompt=consent to the auth URL if re-authorizing).",
    );
  }

  // Preserve the client credentials saved in phase 1.
  const existing = await readCredentials();
  const updated: StoredCredentials = {
    client_id: existing?.client_id ?? clientId,
    client_secret: existing?.client_secret ?? clientSecret,
    refresh_token: tokenData.refresh_token,
    access_token: tokenData.access_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };

  // Fetch and cache the account email.
  const email = await fetchUserEmail(tokenData.access_token);
  if (email) {
    updated.email = email;
  }

  await writeCredentials(updated);
}

/**
 * Build the Google OAuth2 consent URL.
 *
 * The returned URL includes all required scopes and forces the consent screen
 * to appear (`prompt=consent`) so that Google always issues a refresh token,
 * even when the user has previously authorized the same client.
 *
 * @param clientId    - Google OAuth2 client ID.
 * @param clientSecret - Google OAuth2 client secret (included for API symmetry
 *                       but not used in the URL; the secret is sent at token-
 *                       exchange time).
 * @param redirectUri - The callback URL registered in Google Cloud Console.
 *                      For the local callback server, use
 *                      `http://localhost:9004/oauth/callback`.
 *
 * @returns Fully-formed authorization URL to open in the user's browser.
 *
 * @example
 * const url = getAuthUrl(clientId, clientSecret,
 *   "http://localhost:9004/oauth/callback");
 * // => "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&..."
 */
export function getAuthUrl(
  clientId: string,
  _clientSecret: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_BASE_URL}?${params.toString()}`;
}

/**
 * Delete `credentials.json` from the data directory, effectively disconnecting
 * the Google account.
 *
 * After this call {@link isConfigured} returns `false` and
 * {@link getAccessToken} will throw until the setup flow is completed again.
 * Silently succeeds if the file does not exist.
 *
 * @example
 * await clearCredentials();
 * // isConfigured() === false
 */
export async function clearCredentials(): Promise<void> {
  try {
    await Deno.remove(credentialsPath());
  } catch (err) {
    // Ignore "file not found" — treat as already cleared.
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
}

/**
 * Return the email address associated with the currently connected Google
 * account.
 *
 * First checks the cached `email` field in `credentials.json` to avoid an
 * extra network call.  If not cached, fetches it live from the userinfo
 * endpoint and caches it for subsequent calls.
 *
 * @returns The email address string, or `null` if not configured or the
 *          request fails.
 *
 * @example
 * const email = await getConnectedEmail();
 * // => "user@gmail.com" or null
 */
export async function getConnectedEmail(): Promise<string | null> {
  const creds = await readCredentials();
  if (!creds?.refresh_token) return null;

  // Return cached value if available.
  if (creds.email) return creds.email;

  try {
    const token = await getAccessToken();
    const email = await fetchUserEmail(token);
    if (email) {
      await writeCredentials({ ...creds, email });
    }
    return email;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth callback HTTP server
// ---------------------------------------------------------------------------

/**
 * Start the temporary OAuth2 callback HTTP server on the given port.
 *
 * The server exposes four routes used by the setup wizard UI:
 *
 * | Route                | Method | Purpose                                             |
 * |----------------------|--------|-----------------------------------------------------|
 * | `/save-credentials`  | POST   | Save client ID/secret, return auth URL as JSON      |
 * | `/oauth/callback`    | GET    | Receive Google redirect, exchange code, return HTML |
 * | `/status`            | GET    | Return `{ configured, email }` as JSON              |
 * | `/disconnect`        | POST   | Clear credentials, return JSON confirmation         |
 *
 * The server adds CORS headers to every response so that the browser-rendered
 * setup wizard (served from the daemon's own interface route) can call it via
 * `fetch()`.
 *
 * After credentials are successfully obtained via `/oauth/callback` the server
 * shuts itself down automatically (the callback handler calls
 * {@link stopOAuthCallbackServer}).
 *
 * Only one callback server may be active at a time.  Calling this function
 * while a server is already running returns the existing instance without
 * starting a second one.
 *
 * @param port - TCP port to listen on (typically 9004).
 * @returns The `Deno.HttpServer` instance (returned synchronously;
 *          `Deno.serve()` itself is non-blocking).
 *
 * @example
 * const server = startOAuthCallbackServer(9004);
 */
export function startOAuthCallbackServer(
  port: number,
): Deno.HttpServer {
  if (_callbackServer !== null) {
    return _callbackServer;
  }

  _callbackServer = Deno.serve(
    { port, onListen: () => {} },
    async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

      // Handle CORS preflight.
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // ── POST /save-credentials ──────────────────────────────────────────
        if (req.method === "POST" && url.pathname === "/save-credentials") {
          return await handleSaveCredentials(req, corsHeaders, port);
        }

        // ── GET /oauth/callback ─────────────────────────────────────────────
        if (req.method === "GET" && url.pathname === "/oauth/callback") {
          return await handleOAuthCallback(url, corsHeaders);
        }

        // ── GET /status ─────────────────────────────────────────────────────
        if (req.method === "GET" && url.pathname === "/status") {
          return await handleStatus(corsHeaders);
        }

        // ── POST /disconnect ────────────────────────────────────────────────
        if (req.method === "POST" && url.pathname === "/disconnect") {
          return await handleDisconnect(corsHeaders);
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    },
  );

  // Prevent Deno's default behaviour of holding the process open for the server.
  _callbackServer.unref();

  return _callbackServer;
}

/**
 * Stop the OAuth callback HTTP server and free its port.
 *
 * Safe to call when no server is running (no-op in that case).  The shutdown
 * is asynchronous internally; the port may remain briefly occupied while
 * in-flight requests complete.
 *
 * @example
 * stopOAuthCallbackServer();
 */
export function stopOAuthCallbackServer(): void {
  if (_callbackServer === null) return;
  const server = _callbackServer;
  _callbackServer = null;
  server.shutdown().catch((err) => {
    console.error("[auth] Failed to shut down OAuth callback server:", err);
  });
}

// ---------------------------------------------------------------------------
// Route handlers (private)
// ---------------------------------------------------------------------------

/**
 * Handle `POST /save-credentials`.
 *
 * Reads `{ client_id, client_secret }` from the JSON request body, persists
 * them via {@link saveCredentials}, and returns the OAuth2 consent URL so the
 * UI can open it in a new tab.
 *
 * @param req         - The incoming HTTP request.
 * @param corsHeaders - CORS headers to include in the response.
 * @param port        - The port the callback server is listening on (used to
 *                      build the `redirect_uri`).
 * @returns JSON response containing `{ authUrl }` or `{ error }`.
 */
async function handleSaveCredentials(
  req: Request,
  corsHeaders: Record<string, string>,
  port: number,
): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const clientId = body.client_id;
  const clientSecret = body.client_secret;

  if (typeof clientId !== "string" || !clientId.trim()) {
    return jsonResponse({ error: "client_id is required" }, 400, corsHeaders);
  }
  if (typeof clientSecret !== "string" || !clientSecret.trim()) {
    return jsonResponse(
      { error: "client_secret is required" },
      400,
      corsHeaders,
    );
  }

  await saveCredentials(clientId.trim(), clientSecret.trim());

  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const authUrl = getAuthUrl(clientId.trim(), clientSecret.trim(), redirectUri);

  return jsonResponse({ authUrl }, 200, corsHeaders);
}

/**
 * Handle `GET /oauth/callback`.
 *
 * Called by Google after the user completes the consent screen.  Extracts the
 * authorization `code` from the query string, exchanges it for tokens via
 * {@link handleAuthCallback}, and returns an HTML success page.  On success
 * the callback server stops itself.
 *
 * If the query string contains an `error` parameter (user denied access), an
 * error page is returned instead.
 *
 * @param url         - Parsed URL of the incoming request.
 * @param corsHeaders - CORS headers to include in the response.
 * @returns HTML response (success or error page).
 */
async function handleOAuthCallback(
  url: URL,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      buildErrorPage(
        `Google authorization was denied: ${error}. Please close this tab and try again.`,
      ),
      400,
      corsHeaders,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return htmlResponse(
      buildErrorPage("No authorization code received from Google."),
      400,
      corsHeaders,
    );
  }

  const creds = await readCredentials();
  if (!creds?.client_id || !creds?.client_secret) {
    return htmlResponse(
      buildErrorPage(
        "Client credentials not found. Please restart the setup process.",
      ),
      500,
      corsHeaders,
    );
  }

  const redirectUri = url.origin + "/oauth/callback";
  await handleAuthCallback(code, creds.client_id, creds.client_secret, redirectUri);

  // Fetch the email for the success message.
  const email = await getConnectedEmail();

  // Shut down the server now that we have tokens — port is freed.
  stopOAuthCallbackServer();

  return htmlResponse(buildSuccessPage(email ?? "your account"), 200, corsHeaders);
}

/**
 * Handle `GET /status`.
 *
 * Returns a JSON object indicating whether a Google account is connected.
 *
 * @param corsHeaders - CORS headers to include in the response.
 * @returns JSON response `{ configured: boolean, email: string | null }`.
 */
async function handleStatus(
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const configured = isConfigured();
  const email = configured ? await getConnectedEmail() : null;
  return jsonResponse({ configured, email }, 200, corsHeaders);
}

/**
 * Handle `POST /disconnect`.
 *
 * Clears all stored credentials, returning the daemon to an unconfigured state.
 *
 * @param corsHeaders - CORS headers to include in the response.
 * @returns JSON response `{ ok: true }`.
 */
async function handleDisconnect(
  corsHeaders: Record<string, string>,
): Promise<Response> {
  await clearCredentials();
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// Private utilities
// ---------------------------------------------------------------------------

/**
 * Fetch the email address for the currently authenticated user from Google's
 * userinfo endpoint.
 *
 * @param accessToken - A valid access token with the `userinfo.email` scope.
 * @returns The email string, or `null` if the request fails.
 */
async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as UserInfoResponse;
    return data.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a `Response` with a JSON body and the given status / headers.
 *
 * @param data        - Value to serialize as JSON.
 * @param status      - HTTP status code.
 * @param extraHeaders - Additional headers to merge (e.g. CORS headers).
 * @returns A `Response` object ready to return from a request handler.
 */
function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

/**
 * Build a `Response` with an HTML body and the given status / headers.
 *
 * @param html        - Full HTML string to send as the response body.
 * @param status      - HTTP status code.
 * @param extraHeaders - Additional headers to merge (e.g. CORS headers).
 * @returns A `Response` object ready to return from a request handler.
 */
function htmlResponse(
  html: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...extraHeaders,
    },
  });
}

/**
 * Build the HTML success page shown to the user after a successful OAuth flow.
 *
 * Displayed in the browser tab that Google redirects to after consent.  The
 * page auto-closes after a short delay so the user does not need to close it
 * manually.
 *
 * @param email - The connected email address to display in the confirmation.
 * @returns A complete HTML document string.
 */
function buildSuccessPage(email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Google Connected — Chalie</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f0fdf4; }
    .card { background: white; border-radius: 12px; padding: 2.5rem 3rem;
            box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center;
            max-width: 440px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { color: #16a34a; margin: 0 0 .5rem; font-size: 1.5rem; }
    p  { color: #4b5563; margin: 0 0 1.5rem; }
    small { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Google Connected!</h1>
    <p>Successfully connected <strong>${escapeHtml(email)}</strong> to Chalie.</p>
    <small>You can close this tab and return to the setup page.</small>
  </div>
  <script>
    // Auto-close after 4 seconds if the tab was opened by the setup wizard.
    setTimeout(() => { try { window.close(); } catch (_) {} }, 4000);
  </script>
</body>
</html>`;
}

/**
 * Build the HTML error page shown when OAuth fails or is denied.
 *
 * @param message - Human-readable error description to display.
 * @returns A complete HTML document string.
 */
function buildErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization Error — Chalie</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #fef2f2; }
    .card { background: white; border-radius: 12px; padding: 2.5rem 3rem;
            box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center;
            max-width: 440px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { color: #dc2626; margin: 0 0 .5rem; font-size: 1.5rem; }
    p  { color: #4b5563; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Authorization Failed</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

/**
 * Escape a string for safe embedding inside HTML text content or attributes.
 *
 * Replaces the five characters that have special meaning in HTML:
 * `&`, `<`, `>`, `"`, `'`.
 *
 * @param str - Raw string that may contain HTML-special characters.
 * @returns HTML-safe string suitable for injection into page content.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
