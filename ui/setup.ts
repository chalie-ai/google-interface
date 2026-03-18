/**
 * Setup wizard UI for the Chalie Google Interface daemon.
 *
 * Exports a single function, {@link renderSetupWizard}, that produces the
 * complete HTML page shown to the user when Google OAuth credentials have not
 * yet been configured.  The page walks the user through:
 *
 *   1. Creating a Google Cloud project and enabling the Gmail + Calendar APIs.
 *   2. Configuring an OAuth consent screen (including the **test-user** step
 *      required for External-type OAuth apps in "Testing" publishing status).
 *   3. Creating an OAuth 2.0 "Desktop app" client and copying its credentials.
 *   4. Entering the client ID and secret into the wizard form.
 *   5. Completing the Google consent screen in a new browser tab.
 *
 * ## Client-side flow
 *
 * All JavaScript in the returned HTML page communicates exclusively with the
 * OAuth callback server running on **port 9004** — it does NOT use
 * `window.chalie.execute()`.  The endpoints used are:
 *
 * | Endpoint                            | When                                   |
 * |-------------------------------------|----------------------------------------|
 * | `POST localhost:9004/save-credentials` | On form submit                      |
 * | `GET  localhost:9004/status`           | Polled every 2 s after form submit  |
 *
 * ## States
 *
 * The page renders one of three visual states controlled by a tiny state
 * machine in the inline JavaScript:
 *
 * - **`form`** — default; shows the step guide and the credentials form.
 * - **`pending`** — shown after a successful `save-credentials` call; displays
 *   a Bootstrap spinner and polls `/status` every 2 seconds.
 * - **`success`** — shown when `/status` returns `{ configured: true }`;
 *   displays the connected email address.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port the OAuth callback server listens on (must match `auth.ts`). */
const CALLBACK_PORT = 9004;

/** The exact redirect URI that must be registered in Google Cloud Console. */
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth/callback`;

/** Bootstrap 5 CDN stylesheet URL. */
const BOOTSTRAP_CSS_URL =
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css";

/** Bootstrap 5 CDN bundle (includes Popper) URL. */
const BOOTSTRAP_JS_URL =
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the full HTML setup wizard page as a string.
 *
 * Called by `renderInterface()` in `daemon.ts` when {@link isConfigured}
 * returns `false`.  The returned string is the complete HTTP response body
 * for the daemon's `/` interface route — it is a valid HTML5 document.
 *
 * The page is self-contained: all CSS comes from Bootstrap 5 (CDN link in
 * `<head>`) and all JavaScript is inlined.  No external scripts other than
 * the Bootstrap bundle are loaded.
 *
 * @returns A complete HTML document string for the setup wizard.
 *
 * @example
 * // In daemon.ts:
 * async function renderInterface(): Promise<string> {
 *   if (!isConfigured()) {
 *     return renderSetupWizard();
 *   }
 *   return renderMainView();
 * }
 */
export function renderSetupWizard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connect Google Account — Chalie</title>
  <link
    rel="stylesheet"
    href="${BOOTSTRAP_CSS_URL}"
    integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH"
    crossorigin="anonymous"
  />
  <style>
    /*
     * Minimal overrides — Bootstrap provides the bulk of the styling.
     * These rules handle layout tweaks that Bootstrap doesn't cover out of
     * the box (e.g. the sticky redirect URI display).
     */
    body {
      background-color: #f8f9fa;
    }
    .wizard-card {
      max-width: 720px;
    }
    .redirect-uri-box {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
      font-size: 0.875rem;
      background: #f1f3f5;
      border: 1px solid #dee2e6;
      border-radius: 0.375rem;
      padding: 0.5rem 0.75rem;
      user-select: all;
      word-break: break-all;
    }
    .step-badge {
      width: 1.75rem;
      height: 1.75rem;
      font-size: 0.8rem;
      flex-shrink: 0;
    }
    #state-pending,
    #state-success {
      display: none;
    }
  </style>
</head>
<body>

<div class="container py-5">
  <div class="wizard-card mx-auto">

    <!-- ── Page header ──────────────────────────────────────────────────── -->
    <div class="text-center mb-4">
      <h1 class="h3 fw-bold">Connect Your Google Account</h1>
      <p class="text-muted">
        Follow the steps below to link Gmail and Google Calendar with Chalie.
        This only needs to be done once.
      </p>
    </div>

    <!-- ================================================================== -->
    <!--  STATE: FORM                                                        -->
    <!-- ================================================================== -->
    <div id="state-form">

      <div class="card shadow-sm mb-4">
        <div class="card-header bg-white fw-semibold py-3">
          Step-by-step setup guide
        </div>
        <div class="card-body">

          <!-- Step 1 — Create project ------------------------------------ -->
          <div class="d-flex gap-3 mb-4">
            <span
              class="step-badge badge rounded-circle bg-primary d-flex align-items-center justify-content-center"
            >1</span>
            <div>
              <p class="mb-1 fw-semibold">Create a Google Cloud project</p>
              <ol class="mb-0 ps-3 text-secondary small">
                <li>
                  Go to
                  <a
                    href="https://console.cloud.google.com/projectcreate"
                    target="_blank"
                    rel="noopener noreferrer"
                  >console.cloud.google.com/projectcreate</a>.
                </li>
                <li>Enter a project name (e.g. <em>Chalie Integration</em>).</li>
                <li>Click <strong>Create</strong> and wait for it to finish.</li>
                <li>
                  Make sure your new project is selected in the dropdown at the
                  top of the page before continuing.
                </li>
              </ol>
            </div>
          </div>

          <!-- Step 2 — Enable APIs --------------------------------------- -->
          <div class="d-flex gap-3 mb-4">
            <span
              class="step-badge badge rounded-circle bg-primary d-flex align-items-center justify-content-center"
            >2</span>
            <div>
              <p class="mb-1 fw-semibold">Enable Gmail and Calendar APIs</p>
              <ol class="mb-0 ps-3 text-secondary small">
                <li>
                  Open the
                  <a
                    href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
                    target="_blank"
                    rel="noopener noreferrer"
                  >Gmail API page</a>
                  and click <strong>Enable</strong>.
                </li>
                <li>
                  Open the
                  <a
                    href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"
                    target="_blank"
                    rel="noopener noreferrer"
                  >Google Calendar API page</a>
                  and click <strong>Enable</strong>.
                </li>
                <li>
                  <em>Reminder:</em> ensure your project is still selected in the
                  top-of-page dropdown before enabling each API.
                </li>
              </ol>
            </div>
          </div>

          <!-- Step 3 — OAuth consent screen ------------------------------ -->
          <div class="d-flex gap-3 mb-4">
            <span
              class="step-badge badge rounded-circle bg-primary d-flex align-items-center justify-content-center"
            >3</span>
            <div>
              <p class="mb-1 fw-semibold">Configure the OAuth consent screen</p>
              <ol class="mb-0 ps-3 text-secondary small">
                <li>
                  Go to
                  <a
                    href="https://console.cloud.google.com/apis/credentials/consent"
                    target="_blank"
                    rel="noopener noreferrer"
                  >APIs &amp; Services → OAuth consent screen</a>.
                </li>
                <li>
                  Select <strong>External</strong> user type, then click
                  <strong>Create</strong>.
                </li>
                <li>
                  Fill in the <em>App name</em> (e.g. <em>Chalie</em>),
                  <em>User support email</em>, and
                  <em>Developer contact email</em>. Click
                  <strong>Save and Continue</strong>.
                </li>
                <li>
                  On the <strong>Scopes</strong> screen you don't need to add
                  any scopes manually — click <strong>Save and Continue</strong>.
                </li>
                <li>
                  <strong class="text-danger">Important — Test Users:</strong>
                  On the <strong>Test users</strong> screen, click
                  <strong>+ Add Users</strong> and enter the Google email address
                  you want to connect (e.g. <code>you@gmail.com</code>). Click
                  <strong>Add</strong>, then <strong>Save and Continue</strong>.
                  <br />
                  <span class="text-muted">
                    Google requires this for External apps in "Testing" publishing
                    status — only listed test users can complete the OAuth flow.
                  </span>
                </li>
                <li>Review the summary and click <strong>Back to Dashboard</strong>.</li>
              </ol>
            </div>
          </div>

          <!-- Step 4 — Create OAuth client ------------------------------- -->
          <div class="d-flex gap-3 mb-4">
            <span
              class="step-badge badge rounded-circle bg-primary d-flex align-items-center justify-content-center"
            >4</span>
            <div>
              <p class="mb-1 fw-semibold">Create an OAuth 2.0 client ID</p>
              <ol class="mb-0 ps-3 text-secondary small">
                <li>
                  Go to
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noopener noreferrer"
                  >APIs &amp; Services → Credentials</a>.
                </li>
                <li>
                  Click <strong>+ Create Credentials</strong> →
                  <strong>OAuth client ID</strong>.
                </li>
                <li>
                  For <em>Application type</em>, choose
                  <strong>Desktop app</strong>.
                </li>
                <li>Give it any name, then click <strong>Create</strong>.</li>
                <li>
                  In the confirmation dialog, copy your
                  <strong>Client ID</strong> and
                  <strong>Client Secret</strong> — paste them below.
                </li>
              </ol>
            </div>
          </div>

          <!-- Step 5 — Redirect URI note --------------------------------- -->
          <div class="d-flex gap-3">
            <span
              class="step-badge badge rounded-circle bg-secondary d-flex align-items-center justify-content-center"
            >ℹ</span>
            <div class="w-100">
              <p class="mb-1 fw-semibold">Redirect URI (for reference)</p>
              <p class="text-secondary small mb-2">
                Chalie uses a local callback server to receive Google's
                authorization code. The redirect URI below is handled
                automatically — you do not need to add it anywhere in the
                Cloud Console for Desktop app clients.
              </p>
              <div class="redirect-uri-box">${REDIRECT_URI}</div>
            </div>
          </div>

        </div><!-- /.card-body -->
      </div><!-- /.card -->

      <!-- ── Credentials form ─────────────────────────────────────────── -->
      <div class="card shadow-sm">
        <div class="card-header bg-white fw-semibold py-3">
          Enter your OAuth credentials
        </div>
        <div class="card-body">

          <div id="form-error" class="alert alert-danger d-none" role="alert"></div>

          <form id="credentials-form" novalidate>
            <div class="mb-3">
              <label for="client-id" class="form-label fw-semibold">
                Client ID
              </label>
              <input
                type="text"
                class="form-control font-monospace"
                id="client-id"
                name="client_id"
                placeholder="1234567890-abcdefg.apps.googleusercontent.com"
                autocomplete="off"
                spellcheck="false"
                required
              />
              <div class="invalid-feedback">Client ID is required.</div>
            </div>

            <div class="mb-4">
              <label for="client-secret" class="form-label fw-semibold">
                Client Secret
              </label>
              <input
                type="password"
                class="form-control font-monospace"
                id="client-secret"
                name="client_secret"
                placeholder="GOCSPX-…"
                autocomplete="off"
                spellcheck="false"
                required
              />
              <div class="invalid-feedback">Client Secret is required.</div>
            </div>

            <button
              type="submit"
              id="connect-btn"
              class="btn btn-primary w-100"
            >
              Save &amp; Connect with Google
            </button>
          </form>

        </div>
      </div><!-- /.card -->

    </div><!-- /#state-form -->


    <!-- ================================================================== -->
    <!--  STATE: PENDING (polling)                                           -->
    <!-- ================================================================== -->
    <div id="state-pending">
      <div class="card shadow-sm text-center py-5">
        <div class="card-body">
          <div
            class="spinner-border text-primary mb-4"
            style="width: 3rem; height: 3rem;"
            role="status"
          >
            <span class="visually-hidden">Waiting for Google authorization…</span>
          </div>
          <h2 class="h5 fw-semibold mb-2">Waiting for Google authorization</h2>
          <p class="text-muted mb-1">
            A new tab has opened with Google's consent screen.
          </p>
          <p class="text-muted mb-4">
            Sign in and grant access, then return here — this page will update
            automatically.
          </p>
          <p class="small text-secondary">
            Didn't see a new tab?
            <a href="#" id="reopen-link">Click here to open it again</a>.
          </p>
        </div>
      </div>
    </div><!-- /#state-pending -->


    <!-- ================================================================== -->
    <!--  STATE: SUCCESS                                                     -->
    <!-- ================================================================== -->
    <div id="state-success">
      <div class="card shadow-sm text-center py-5">
        <div class="card-body">
          <div class="fs-1 mb-3">✅</div>
          <h2 class="h5 fw-semibold text-success mb-2">Google Account Connected!</h2>
          <p class="text-muted mb-0">
            Successfully connected
            <strong id="connected-email"></strong>
            to Chalie.
          </p>
          <p class="text-muted small mt-2">
            Gmail and Calendar sync will begin within the next minute.
            You can manage the connection in Settings.
          </p>
        </div>
      </div>
    </div><!-- /#state-success -->

  </div><!-- /.wizard-card -->
</div><!-- /.container -->

<!-- Bootstrap JS bundle (includes Popper) -->
<script
  src="${BOOTSTRAP_JS_URL}"
  integrity="sha384-YvpcrYf0tY3lHB60NNkmXc4s9bIOgUxi8T/jzmrXE53rSebu+nLWZ6BRqzFxBxLI"
  crossorigin="anonymous"
></script>

<script>
  /**
   * Setup wizard client-side state machine.
   *
   * States: "form" → "pending" → "success"
   *
   * Transitions:
   *   form    → pending  : credentials saved, auth URL opened in new tab
   *   pending → success  : /status polling returns { configured: true }
   */
  (function () {
    "use strict";

    // ── Constants ──────────────────────────────────────────────────────────
    var BASE_URL     = "http://localhost:${CALLBACK_PORT}";
    var POLL_INTERVAL_MS = 2000;

    // ── Element refs ───────────────────────────────────────────────────────
    var stateForm    = document.getElementById("state-form");
    var statePending = document.getElementById("state-pending");
    var stateSuccess = document.getElementById("state-success");
    var form         = document.getElementById("credentials-form");
    var clientIdEl   = document.getElementById("client-id");
    var clientSecEl  = document.getElementById("client-secret");
    var connectBtn   = document.getElementById("connect-btn");
    var formError    = document.getElementById("form-error");
    var emailEl      = document.getElementById("connected-email");
    var reopenLink   = document.getElementById("reopen-link");

    /** Currently-stored OAuth consent URL (used by the "open again" link). */
    var lastAuthUrl = null;

    /** setInterval handle for the /status poller. */
    var pollHandle  = null;

    // ── State transitions ──────────────────────────────────────────────────

    /**
     * Switch the visible state section.
     *
     * @param {string} name - One of "form", "pending", or "success".
     */
    function showState(name) {
      stateForm.style.display    = name === "form"    ? "" : "none";
      statePending.style.display = name === "pending" ? "" : "none";
      stateSuccess.style.display = name === "success" ? "" : "none";
    }

    // ── Error display ──────────────────────────────────────────────────────

    /**
     * Show an error alert inside the form card.
     *
     * @param {string} message - Human-readable error text to display.
     */
    function showFormError(message) {
      formError.textContent = message;
      formError.classList.remove("d-none");
    }

    /** Hide the form error alert. */
    function hideFormError() {
      formError.classList.add("d-none");
      formError.textContent = "";
    }

    // ── /status poller ─────────────────────────────────────────────────────

    /**
     * Start polling GET /status every POLL_INTERVAL_MS milliseconds.
     * On { configured: true }, stop polling and transition to "success".
     */
    function startPolling() {
      if (pollHandle !== null) return; // already polling

      pollHandle = setInterval(function () {
        fetch(BASE_URL + "/status")
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && data.configured === true) {
              stopPolling();
              // Show the connected email, defaulting to a generic label.
              emailEl.textContent = data.email || "your account";
              showState("success");
            }
          })
          .catch(function () {
            // Swallow network errors — the callback server may not yet be
            // available on every tick; keep polling silently.
          });
      }, POLL_INTERVAL_MS);
    }

    /** Stop the /status polling interval. */
    function stopPolling() {
      if (pollHandle !== null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    }

    // ── Form submission ────────────────────────────────────────────────────

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      event.stopPropagation();

      hideFormError();

      var clientId     = clientIdEl.value.trim();
      var clientSecret = clientSecEl.value.trim();

      // Bootstrap validation classes.
      form.classList.add("was-validated");

      if (!clientId || !clientSecret) {
        // Let Bootstrap's built-in :invalid styles handle display.
        return;
      }

      // Disable button to prevent double-submit.
      connectBtn.disabled = true;
      connectBtn.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' +
        'Saving…';

      fetch(BASE_URL + "/save-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret
        })
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().then(function (body) {
              throw new Error(
                (body && body.error) ||
                ("Server responded with HTTP " + res.status)
              );
            });
          }
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.authUrl) {
            throw new Error(
              "No authorization URL returned. Is the Chalie daemon running?"
            );
          }

          lastAuthUrl = data.authUrl;

          // Open the Google consent screen in a new tab.
          window.open(lastAuthUrl, "_blank", "noopener,noreferrer");

          // Transition to the pending state and begin polling.
          showState("pending");
          startPolling();
        })
        .catch(function (err) {
          // Re-enable the button so the user can retry.
          connectBtn.disabled = false;
          connectBtn.textContent = "Save & Connect with Google";
          showFormError(
            "Could not connect to the Chalie daemon: " +
            (err && err.message ? err.message : String(err)) +
            " — make sure it is running and try again."
          );
        });
    });

    // ── "Open again" link ──────────────────────────────────────────────────

    reopenLink.addEventListener("click", function (event) {
      event.preventDefault();
      if (lastAuthUrl) {
        window.open(lastAuthUrl, "_blank", "noopener,noreferrer");
      }
    });

    // ── Initial state ──────────────────────────────────────────────────────

    // Start with the form visible (pending/success are hidden via CSS).
    showState("form");

    // If the daemon is already configured (e.g. user refreshed the page after
    // completing auth), skip straight to the success state without requiring
    // another form submit.
    fetch(BASE_URL + "/status")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.configured === true) {
          emailEl.textContent = data.email || "your account";
          showState("success");
        }
      })
      .catch(function () {
        // Daemon may not be ready yet — silently stay on the form state.
      });

  }());
</script>

</body>
</html>`;
}
