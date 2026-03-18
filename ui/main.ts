/**
 * Main dashboard view for the Google interface daemon.
 *
 * Provides the primary {@link renderMainView} export that generates a
 * full, self-contained HTML page served at `/` once the daemon has been
 * successfully authorised.  The page contains:
 *
 * - A Bootstrap 5 top-navbar with the app title, the connected Google email
 *   address, and a gear icon that toggles the settings panel.
 * - A tabbed content area with a "Gmail" tab and a "Calendar" tab.
 * - Gmail tab: full-text search bar, search result cards, and a set of
 *   suggested prompt strings (copy-to-clipboard with toast feedback).
 * - Calendar tab: today's events loaded automatically on page render, plus a
 *   date-range picker that reloads the event list for any chosen window.
 * - The settings panel HTML (produced by `ui/settings.ts`) injected inline
 *   and shown/hidden via the gear icon toggle.
 *
 * All calls to `window.chalie.execute()` are wrapped in try/catch and surface
 * user-visible error toasts so a missing gateway produces a clear message
 * rather than a silent failure.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// HTML-escape helper (duplicated from settings.ts — that helper is private)
// ---------------------------------------------------------------------------

/**
 * Escape special HTML characters so a string is safe to embed in HTML text
 * nodes and attribute values.
 *
 * Characters escaped: `&`, `<`, `>`, `"`, `'`.
 *
 * @param {string} str - Raw input string.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// Suggested prompts
// ---------------------------------------------------------------------------

/** A prompt string shown as a copyable chip in the Gmail tab. */
interface SuggestedPrompt {
  /** Short human-readable label rendered on the chip button. */
  label: string;
  /** Full prompt text written to the clipboard on click. */
  prompt: string;
}

/**
 * Curated list of Gmail-related prompts that help users discover common
 * actions they can ask Chalie to perform.
 */
const GMAIL_PROMPTS: SuggestedPrompt[] = [
  { label: "Show unread emails", prompt: "Show me my unread emails" },
  {
    label: "Search from someone",
    prompt: "Search for emails from [name or address]",
  },
  {
    label: "Search by topic",
    prompt: "Show me emails about [topic]",
  },
  {
    label: "Recent inbox",
    prompt: "Show me the last 10 emails in my inbox",
  },
  {
    label: "Emails with attachments",
    prompt: "Find emails that have attachments",
  },
  {
    label: "Draft a reply",
    prompt: "Draft a reply to the latest email from [name]",
  },
];

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

/**
 * Render the full main-dashboard HTML page.
 *
 * The returned string is a complete HTML document ready to be served by the
 * SDK's `/` route.  It embeds Bootstrap 5 from the official CDN and includes
 * all page logic as inline `<script>` blocks — no external JS bundles are
 * needed beyond Bootstrap.
 *
 * ### Layout
 * ```
 * <nav>  ← title + connected email + ⚙ gear toggle
 * <main>
 *   [settings panel — hidden by default, shown on gear click]
 *   [Gmail | Calendar] tabs
 *   Gmail tab:
 *     - search bar  → gmail_search capability
 *     - result cards (EmailSummary)
 *     - suggested prompts (copy to clipboard)
 *   Calendar tab:
 *     - date range picker
 *     - event list  → calendar_events capability (auto-loaded for "today")
 * </main>
 * ```
 *
 * ### Error handling
 * Every `window.chalie.execute()` call is wrapped in try/catch.  On error a
 * dismissible toast is shown with the message
 * "Couldn't reach Chalie. Make sure it's running."
 *
 * @param {string | null} connectedEmail - The authenticated Google account
 *   email address, or `null` if unavailable (shows a placeholder).
 * @param {string} settingsHtml - The HTML fragment produced by
 *   `renderSettingsPanel()` from `ui/settings.ts`.  It is injected directly
 *   into the page and toggled visible/hidden by the gear icon.
 * @returns {string} A complete HTML page string.
 *
 * @example
 * import { renderMainView } from "./ui/main.ts";
 * import { renderSettingsPanel, loadSettings } from "./ui/settings.ts";
 * import { getConnectedEmail } from "./google/auth.ts";
 *
 * const settings = await loadSettings();
 * const email = await getConnectedEmail();
 * const settingsHtml = renderSettingsPanel(settings, email);
 * const page = renderMainView(email, settingsHtml);
 */
export function renderMainView(
  connectedEmail: string | null,
  settingsHtml: string,
): string {
  const emailDisplay = connectedEmail
    ? `<span class="navbar-text text-light opacity-75 small me-2">
         <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
              fill="currentColor" class="bi bi-google me-1" viewBox="0 0 16 16"
              aria-hidden="true">
           <path d="M15.545 6.558a9.42 9.42 0 0 1 .139 1.626c0 2.434-.87
                    4.492-2.384 5.885h.002C11.978 15.292 10.158 16 8 16A8 8 0
                    1 1 8 0a7.689 7.689 0 0 1 5.352 2.082l-2.284
                    2.284A4.347 4.347 0 0 0 8 3.166c-2.087 0-3.86
                    1.408-4.492 3.304a4.792 4.792 0 0 0 0 3.063h.003c.635
                    1.893 2.405 3.301 4.492 3.301 1.078 0 2.004-.276
                    2.722-.764h-.003a3.702 3.702 0 0 0
                    1.599-2.431H8v-3.08z"/>
         </svg>
         ${escapeHtml(connectedEmail)}
       </span>`
    : `<span class="navbar-text text-light opacity-50 small me-2 fst-italic">
         No account connected
       </span>`;

  const promptChips = GMAIL_PROMPTS.map((p) =>
    `<button
       type="button"
       class="btn btn-sm btn-outline-secondary me-2 mb-2 prompt-chip"
       data-prompt="${escapeHtml(p.prompt)}"
       title="${escapeHtml(p.prompt)}"
       onclick="copyPrompt(this)">
       ${escapeHtml(p.label)}
     </button>`
  ).join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Google for Chalie</title>

  <!-- Bootstrap 5 CSS (CDN) -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
    integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH"
    crossorigin="anonymous"
  />

  <style>
    body { background-color: #f8f9fa; }
    #settings-wrapper { display: none; }
    #settings-wrapper.visible { display: block; }
    .email-card { cursor: default; transition: box-shadow .15s; }
    .email-card:hover { box-shadow: 0 .25rem .75rem rgba(0,0,0,.1); }
    .email-unread .card-title { font-weight: 700; }
    .event-card { border-left: 4px solid #0d6efd; }
    .event-card.all-day { border-left-color: #198754; }
    #global-toast-container {
      position: fixed; bottom: 1.5rem; end: 1.5rem; right: 1.5rem;
      z-index: 1090; min-width: 280px;
    }
    .tab-pane { padding-top: 1.5rem; }
    #calendar-loading, #gmail-loading { display: none; }
  </style>
</head>
<body>

<!-- =========================================================
     NAVBAR
     ========================================================= -->
<nav class="navbar navbar-dark bg-primary shadow-sm px-3">
  <span class="navbar-brand fw-bold">
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
         fill="currentColor" class="bi bi-envelope-at-fill me-2"
         viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 2A2 2 0 0 0 .05 3.555L8 8.414l7.95-4.859A2 2 0 0 0
               14 2zm-2 9.8V4.698l5.803 3.546zm6.761-2.97-6.57
               4.026A2 2 0 0 0 2 14h6.256A4.493 4.493 0 0 1 8
               12.5a4.49 4.49 0 0 1 1.606-3.446l-.367-.225L8
               9.586zM16 9.671V4.697l-5.803 3.546.338.208A4.482
               4.482 0 0 1 12.5 8c1.414 0 2.675.652 3.5 1.671"/>
      <path d="M15.834 12.244c0 1.168-.577 2.025-1.587 2.025-.503
               0-1.002-.228-1.12-.648h-.043c-.118.416-.543.643-1.015.643-.77
               0-1.259-.542-1.259-1.434v-.529c0-.844.481-1.4
               1.26-1.4.585 0 .87.333.953.63h.03v-.568h.905v2.19c0
               .272.18.42.411.42.315 0 .639-.415.639-1.39v-.118c0-1.277-.95-2.326-2.484-2.326h-.04c-1.582
               0-2.64 1.067-2.64 2.724v.157c0 1.867 1.237 2.654
               2.57 2.654h.045c.507 0 .935-.07 1.18-.18v.731c-.219.1-.643.175-1.237.175h-.044C10.438
               16 9 14.82 9 12.646v-.214C9 10.36 10.421 9 12.485
               9h.035c2.12 0 3.314 1.43 3.314 3.034zm-4.04.21v.227c0
               .586.227.8.581.8.31 0 .564-.17.564-.743v-.367c0-.516-.275-.708-.572-.708-.346
               0-.573.245-.573.791"/>
    </svg>
    Google for Chalie
  </span>

  <div class="d-flex align-items-center gap-2">
    ${emailDisplay}
    <!-- Gear icon — toggles settings panel -->
    <button
      type="button"
      id="gear-btn"
      class="btn btn-sm btn-outline-light"
      aria-label="Toggle settings"
      title="Settings"
      onclick="toggleSettings()">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
           fill="currentColor" class="bi bi-gear-fill" viewBox="0 0 16 16"
           aria-hidden="true">
        <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464
                 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987
                 1.987l.169.311c.446.82.023 1.841-.872
                 2.105l-.34.1c-1.4.413-1.4 2.397 0
                 2.81l.34.1a1.464 1.464 0 0 1 .872
                 2.105l-.17.31c-.698 1.283.705 2.686 1.987
                 1.987l.311-.169a1.464 1.464 0 0 1
                 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81
                 0l.1-.34a1.464 1.464 0 0 1
                 2.105-.872l.31.17c1.283.698 2.686-.705
                 1.987-1.987l-.169-.311a1.464 1.464 0 0 1
                 .872-2.105l.34-.1c1.4-.413 1.4-2.397
                 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464
                 1.464 0 0 1-2.105-.872zM8 10.93a2.929 2.929 0 1 1
                 0-5.86 2.929 2.929 0 0 1 0 5.858z"/>
      </svg>
    </button>
  </div>
</nav>

<!-- =========================================================
     MAIN CONTENT
     ========================================================= -->
<main class="container py-4">

  <!-- Settings panel (injected HTML from ui/settings.ts, hidden by default) -->
  <div id="settings-wrapper">
    ${settingsHtml}
  </div>

  <!-- -------------------------------------------------------
       TABS: Gmail | Calendar
       ------------------------------------------------------- -->
  <ul class="nav nav-tabs" id="main-tabs" role="tablist">
    <li class="nav-item" role="presentation">
      <button
        class="nav-link active"
        id="gmail-tab"
        data-bs-toggle="tab"
        data-bs-target="#gmail-pane"
        type="button"
        role="tab"
        aria-controls="gmail-pane"
        aria-selected="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
             fill="currentColor" class="bi bi-envelope me-1"
             viewBox="0 0 16 16" aria-hidden="true">
          <path d="M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2
                   2H2a2 2 0 0 1-2-2zm2-1a1 1 0 0 0-1 1v.217l7
                   4.2 7-4.2V4a1 1 0 0 0-1-1zm13 2.383-4.708
                   2.825L15 11.105zm-.034 6.876-5.64-3.471L8
                   9.583l-1.326-.795-5.64 3.47A1 1 0 0 0 2 13h12a1
                   1 0 0 0 .966-.741M1 11.105l4.708-2.897L1
                   5.383z"/>
        </svg>
        Gmail
      </button>
    </li>
    <li class="nav-item" role="presentation">
      <button
        class="nav-link"
        id="calendar-tab"
        data-bs-toggle="tab"
        data-bs-target="#calendar-pane"
        type="button"
        role="tab"
        aria-controls="calendar-pane"
        aria-selected="false"
        onclick="loadCalendarIfNeeded()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
             fill="currentColor" class="bi bi-calendar3 me-1"
             viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 0H2a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0
                   2-2V2a2 2 0 0 0-2-2M1 3.857C1 3.384 1.448 3 2 3h12c.552
                   0 1 .384 1 .857v10.286c0 .473-.448.857-1
                   .857H2c-.552 0-1-.384-1-.857z"/>
          <path d="M6.5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2m3
                   0a1 1 0 1 0 0-2 1 1 0 0 0 0 2m3 0a1 1 0 1 0
                   0-2 1 1 0 0 0 0 2m-9 3a1 1 0 1 0 0-2 1 1 0 0 0
                   0 2m3 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2m3 0a1 1 0 1
                   0 0-2 1 1 0 0 0 0 2m3 0a1 1 0 1 0 0-2 1 1 0 0 0
                   0 2m-9 3a1 1 0 1 0 0-2 1 1 0 0 0 0 2m3 0a1 1 0 1
                   0 0-2 1 1 0 0 0 0 2m3 0a1 1 0 1 0 0-2 1 1 0 0 0
                   0 2"/>
        </svg>
        Calendar
      </button>
    </li>
  </ul>

  <div class="tab-content" id="main-tab-content">

    <!-- =====================================================
         GMAIL TAB
         ===================================================== -->
    <div
      class="tab-pane fade show active"
      id="gmail-pane"
      role="tabpanel"
      aria-labelledby="gmail-tab">

      <!-- Search bar -->
      <form
        class="d-flex gap-2 mb-4"
        id="gmail-search-form"
        onsubmit="runGmailSearch(event)">
        <input
          type="search"
          id="gmail-search-input"
          class="form-control"
          placeholder="Search emails (e.g. from:alice subject:invoice)"
          aria-label="Search Gmail" />
        <button type="submit" class="btn btn-primary px-3">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"
               fill="currentColor" class="bi bi-search" viewBox="0 0 16 16"
               aria-hidden="true">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85
                     3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0
                     0-.115-.099zm-5.242 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11"/>
          </svg>
          <span class="ms-1 d-none d-sm-inline">Search</span>
        </button>
      </form>

      <!-- Loading indicator -->
      <div id="gmail-loading" class="text-center py-3" aria-live="polite">
        <div class="spinner-border spinner-border-sm text-primary me-2" role="status">
          <span class="visually-hidden">Loading&hellip;</span>
        </div>
        Searching&hellip;
      </div>

      <!-- Results area -->
      <div id="gmail-results" aria-live="polite"></div>

      <hr class="my-4" />

      <!-- Suggested prompts -->
      <section aria-labelledby="prompts-heading">
        <h6 id="prompts-heading" class="text-uppercase text-muted small fw-semibold mb-1">
          Suggested Prompts
          <span class="fw-normal text-muted" style="text-transform:none">
            — click to copy, then paste into Chalie
          </span>
        </h6>
        <div id="prompt-chips" class="mt-2">
          ${promptChips}
        </div>
        <!-- Copy success toast (inline, near chips) -->
        <div
          id="copy-toast"
          class="alert alert-success py-1 px-3 mt-2 d-inline-block"
          role="status"
          aria-live="polite"
          style="display:none!important">
          Copied to clipboard!
        </div>
      </section>
    </div><!-- /#gmail-pane -->

    <!-- =====================================================
         CALENDAR TAB
         ===================================================== -->
    <div
      class="tab-pane fade"
      id="calendar-pane"
      role="tabpanel"
      aria-labelledby="calendar-tab">

      <!-- Date range picker -->
      <form
        class="row g-2 align-items-end mb-4"
        id="calendar-range-form"
        onsubmit="loadCalendarRange(event)">
        <div class="col-auto">
          <label for="cal-start" class="form-label small mb-1">From</label>
          <input type="date" id="cal-start" class="form-control form-control-sm" />
        </div>
        <div class="col-auto">
          <label for="cal-end" class="form-label small mb-1">To</label>
          <input type="date" id="cal-end" class="form-control form-control-sm" />
        </div>
        <div class="col-auto">
          <button type="submit" class="btn btn-sm btn-primary">Load Range</button>
        </div>
        <div class="col-auto">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            onclick="loadCalendarToday()">
            Today
          </button>
        </div>
      </form>

      <!-- Loading indicator -->
      <div id="calendar-loading" class="text-center py-3" aria-live="polite">
        <div class="spinner-border spinner-border-sm text-primary me-2" role="status">
          <span class="visually-hidden">Loading&hellip;</span>
        </div>
        Loading events&hellip;
      </div>

      <!-- Events area -->
      <div id="calendar-results" aria-live="polite"></div>

    </div><!-- /#calendar-pane -->

  </div><!-- /.tab-content -->
</main>

<!-- =========================================================
     GLOBAL ERROR TOAST CONTAINER
     ========================================================= -->
<div id="global-toast-container" aria-live="assertive" aria-atomic="true"></div>

<!-- =========================================================
     Bootstrap 5 JS bundle (CDN)
     ========================================================= -->
<script
  src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"
  integrity="sha384-YvpcrYf0tY3lHB60NNkmXc4s9bIOgUxi8T/jzmEMFRxJrgdHH4EXe9F5P4GF4T0"
  crossorigin="anonymous"></script>

<!-- =========================================================
     PAGE LOGIC (inline)
     ========================================================= -->
<script>
(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Global error toast
  // -----------------------------------------------------------------------

  /**
   * Render and auto-dismiss a Bootstrap toast in the fixed bottom-right
   * container.  Used for gateway-unreachable errors and any other global
   * notifications that should not block the current UI panel.
   *
   * @param {string} message  - Human-readable message text.
   * @param {"danger"|"warning"|"success"|"info"} [variant="danger"]
   *   Bootstrap colour variant for the toast header.
   */
  function showGlobalToast(message, variant) {
    variant = variant || "danger";
    var container = document.getElementById("global-toast-container");
    var id = "toast-" + Date.now();
    var html =
      '<div id="' + id + '" class="toast align-items-center text-bg-' + variant +
      ' border-0 mb-2" role="alert" aria-live="assertive" aria-atomic="true">' +
      '<div class="d-flex"><div class="toast-body">' +
      escapeHtml(message) +
      '</div><button type="button" class="btn-close btn-close-white me-2 m-auto"' +
      ' data-bs-dismiss="toast" aria-label="Close"></button></div></div>';
    container.insertAdjacentHTML("beforeend", html);
    var el = document.getElementById(id);
    var toast = new bootstrap.Toast(el, { delay: 5000 });
    toast.show();
    el.addEventListener("hidden.bs.toast", function () {
      el.remove();
    });
  }

  /**
   * Escape special HTML characters for safe insertion into the DOM.
   *
   * @param {string} str - Raw string.
   * @returns {string} HTML-safe string.
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  // -----------------------------------------------------------------------
  // Settings panel toggle
  // -----------------------------------------------------------------------

  /**
   * Toggle the settings panel visible/hidden by adding or removing the
   * "visible" class on the wrapper div.  Also flips the gear button's
   * active state styling.
   */
  window.toggleSettings = function toggleSettings() {
    var wrapper = document.getElementById("settings-wrapper");
    var btn = document.getElementById("gear-btn");
    var isVisible = wrapper.classList.toggle("visible");
    btn.classList.toggle("active", isVisible);
    btn.setAttribute("aria-pressed", String(isVisible));
  };

  // -----------------------------------------------------------------------
  // Gmail search
  // -----------------------------------------------------------------------

  /**
   * Handle the Gmail search form submission.
   *
   * Reads the query string from the search input, calls
   * window.chalie.execute('gmail_search', { query }), and renders the
   * returned array of EmailSummary objects as Bootstrap cards.
   *
   * @param {Event} event - The form submit event (default-prevented).
   */
  window.runGmailSearch = async function runGmailSearch(event) {
    event.preventDefault();
    var query = document.getElementById("gmail-search-input").value.trim();
    if (!query) return;

    var loading = document.getElementById("gmail-loading");
    var results = document.getElementById("gmail-results");
    loading.style.display = "block";
    results.innerHTML = "";

    try {
      var data = await window.chalie.execute("gmail_search", { query: query });
      loading.style.display = "none";
      renderEmailResults(results, data);
    } catch (err) {
      loading.style.display = "none";
      showGlobalToast("Couldn\u2019t reach Chalie. Make sure it\u2019s running.");
      console.error("[gmail_search]", err);
    }
  };

  /**
   * Render an array of EmailSummary objects into the given container element
   * as Bootstrap card components.
   *
   * @param {HTMLElement} container - Target DOM node.
   * @param {Array<{id:string, subject:string, from:string, date:string,
   *   snippet:string, unread:boolean, labels:string[]}>} emails
   *   Array of email summary objects (may be empty).
   */
  function renderEmailResults(container, emails) {
    if (!Array.isArray(emails) || emails.length === 0) {
      container.innerHTML =
        '<p class="text-muted fst-italic">No emails found matching your search.</p>';
      return;
    }
    var html = '<div class="d-flex flex-column gap-3">';
    emails.forEach(function (email) {
      var unreadClass = email.isUnread ? " email-unread" : "";
      var badgesHtml = "";
      if (Array.isArray(email.labels)) {
        email.labels.forEach(function (label) {
          if (label !== "INBOX" && label !== "UNREAD") {
            badgesHtml +=
              '<span class="badge bg-secondary me-1">' +
              escapeHtml(label) +
              "</span>";
          }
        });
      }
      html +=
        '<div class="card email-card' + unreadClass + '">' +
        '<div class="card-body py-2 px-3">' +
        '<div class="d-flex justify-content-between align-items-start">' +
        '<h6 class="card-title mb-1">' +
        escapeHtml(email.subject || "(no subject)") +
        (email.isUnread
          ? ' <span class="badge bg-primary ms-1" style="font-size:.65rem">UNREAD</span>'
          : "") +
        "</h6>" +
        '<small class="text-muted text-nowrap ms-2">' +
        escapeHtml(formatEmailDate(email.date)) +
        "</small>" +
        "</div>" +
        '<div class="text-muted small mb-1">' +
        escapeHtml(email.from || "") +
        "</div>" +
        '<p class="card-text small text-muted mb-1">' +
        escapeHtml(email.snippet || "") +
        "</p>" +
        (badgesHtml ? '<div class="mt-1">' + badgesHtml + "</div>" : "") +
        "</div></div>";
    });
    html += "</div>";
    container.innerHTML = html;
  }

  /**
   * Format an ISO date string into a concise human-readable form.
   * Returns the time portion for today's emails, otherwise the date.
   *
   * @param {string} iso - ISO 8601 date string.
   * @returns {string} Formatted date/time string, or empty string on failure.
   */
  function formatEmailDate(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      var now = new Date();
      var sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) {
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    } catch (_) {
      return iso;
    }
  }

  // -----------------------------------------------------------------------
  // Suggested prompts — copy to clipboard
  // -----------------------------------------------------------------------

  /**
   * Copy the prompt text from a chip button to the clipboard.
   *
   * Uses the modern navigator.clipboard.writeText() API when available in a
   * secure context, with a document.execCommand('copy') fallback for
   * older browsers.  Shows a brief inline "Copied!" toast on success.
   *
   * @param {HTMLButtonElement} btn - The chip button that was clicked; its
   *   data-prompt attribute contains the text to copy.
   */
  window.copyPrompt = function copyPrompt(btn) {
    var text = btn.getAttribute("data-prompt") || "";
    if (!text) return;

    /**
     * Show the inline copy-confirmation toast then hide it after 2 seconds.
     */
    function flashCopyToast() {
      var toast = document.getElementById("copy-toast");
      toast.style.setProperty("display", "inline-block", "important");
      setTimeout(function () {
        toast.style.setProperty("display", "none", "important");
      }, 2000);
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(flashCopyToast).catch(function () {
        execCommandCopy(text, flashCopyToast);
      });
    } else {
      execCommandCopy(text, flashCopyToast);
    }
  };

  /**
   * Fallback clipboard copy using a temporary textarea element and
   * document.execCommand('copy').
   *
   * @param {string} text - Text to copy.
   * @param {function} onSuccess - Callback invoked if the copy succeeded.
   */
  function execCommandCopy(text, onSuccess) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) onSuccess();
  }

  // -----------------------------------------------------------------------
  // Calendar
  // -----------------------------------------------------------------------

  /** Whether today's calendar events have been loaded at least once. */
  var _calendarLoaded = false;

  /**
   * Called when the Calendar tab is first clicked.  Loads today's events
   * if they have not been fetched yet, avoiding a duplicate load.
   */
  window.loadCalendarIfNeeded = function loadCalendarIfNeeded() {
    if (!_calendarLoaded) {
      loadCalendarToday();
    }
  };

  /**
   * Load today's events by calling window.chalie.execute('calendar_events',
   * { timeframe: 'today' }) and rendering the results.
   *
   * Also clears the date range inputs so they do not show stale values.
   */
  window.loadCalendarToday = async function loadCalendarToday() {
    document.getElementById("cal-start").value = "";
    document.getElementById("cal-end").value = "";
    await fetchAndRenderEvents({ timeframe: "today" }, "Today\u2019s Events");
  };

  /**
   * Handle the calendar date-range form submission.
   *
   * Reads cal-start and cal-end input values and calls
   * window.chalie.execute('calendar_events', { start_date, end_date }).
   *
   * @param {Event} event - The form submit event (default-prevented).
   */
  window.loadCalendarRange = async function loadCalendarRange(event) {
    event.preventDefault();
    var start = document.getElementById("cal-start").value;
    var end = document.getElementById("cal-end").value;
    if (!start && !end) {
      await loadCalendarToday();
      return;
    }
    var params = {};
    if (start) params.start_date = start;
    if (end) params.end_date = end;
    var label =
      start && end
        ? escapeHtml(start) + " \u2013 " + escapeHtml(end)
        : start
        ? "From " + escapeHtml(start)
        : "Until " + escapeHtml(end);
    await fetchAndRenderEvents(params, label);
  };

  /**
   * Call window.chalie.execute('calendar_events', params) and render the
   * results under the given section heading.
   *
   * Shows a loading spinner while the request is in flight and an error toast
   * if the gateway is unreachable.
   *
   * @param {Record<string, string>} params - Parameters forwarded to the
   *   calendar_events capability.
   * @param {string} heading - Section heading displayed above the event list.
   */
  async function fetchAndRenderEvents(params, heading) {
    var loading = document.getElementById("calendar-loading");
    var results = document.getElementById("calendar-results");
    loading.style.display = "block";
    results.innerHTML = "";

    try {
      var data = await window.chalie.execute("calendar_events", params);
      _calendarLoaded = true;
      loading.style.display = "none";
      renderCalendarResults(results, data, heading);
    } catch (err) {
      loading.style.display = "none";
      showGlobalToast("Couldn\u2019t reach Chalie. Make sure it\u2019s running.");
      console.error("[calendar_events]", err);
    }
  }

  /**
   * Render an array of CalendarEvent objects into the given container element.
   *
   * Each event is displayed as a left-bordered Bootstrap card with the event
   * title, time range, location (if present), and a link to Google Calendar
   * (if provided).
   *
   * @param {HTMLElement} container - Target DOM node.
   * @param {Array<{id:string, summary:string, start:string, end:string,
   *   allDay:boolean, location?:string, description?:string,
   *   htmlLink?:string, attendees?:string[]}>} events
   *   Array of calendar event objects (may be empty).
   * @param {string} heading - Section heading rendered above the list.
   */
  function renderCalendarResults(container, events, heading) {
    var html = '<h6 class="text-muted small fw-semibold text-uppercase mb-3">' +
      escapeHtml(heading) + "</h6>";

    if (!Array.isArray(events) || events.length === 0) {
      html += '<p class="text-muted fst-italic">No events found for this period.</p>';
      container.innerHTML = html;
      return;
    }

    html += '<div class="d-flex flex-column gap-3">';
    events.forEach(function (ev) {
      var timeLabel = ev.allDay
        ? "All day"
        : formatEventTime(ev.start) + " \u2013 " + formatEventTime(ev.end);

      html +=
        '<div class="card event-card' + (ev.allDay ? " all-day" : "") + '">' +
        '<div class="card-body py-2 px-3">' +
        '<div class="d-flex justify-content-between align-items-start">' +
        '<h6 class="card-title mb-1">' + escapeHtml(ev.summary || "(No title)") + "</h6>" +
        '<small class="text-muted text-nowrap ms-2">' + escapeHtml(timeLabel) + "</small>" +
        "</div>";

      if (ev.location) {
        html +=
          '<div class="small text-muted mb-1">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"' +
          ' fill="currentColor" class="bi bi-geo-alt me-1" viewBox="0 0 16 16"' +
          ' aria-hidden="true"><path d="M12.166 8.94c-.524 1.062-1.234 2.12-1.96' +
          " 3.07A32 32 0 0 1 8 14.58a32 32 0 0 1-2.206-2.57c-.726-.95-1.436-2.008-1.96-3.07C3.304" +
          " 7.867 3 6.862 3 6a5 5 0 0 1 10 0c0 .862-.305 1.867-.834" +
          ' 2.94M8 16s6-5.686 6-10A6 6 0 0 0 2 6c0 4.314 6 10 6 10"/>' +
          '<path d="M8 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4"/></svg>' +
          escapeHtml(ev.location) +
          "</div>";
      }

      if (ev.description) {
        html +=
          '<p class="card-text small text-muted mb-1">' +
          escapeHtml(ev.description.slice(0, 120)) +
          (ev.description.length > 120 ? "\u2026" : "") +
          "</p>";
      }

      if (ev.htmlLink) {
        html +=
          '<a href="' + escapeHtml(ev.htmlLink) + '" target="_blank"' +
          ' rel="noopener noreferrer" class="small">' +
          "Open in Google Calendar" +
          "</a>";
      }

      html += "</div></div>";
    });

    html += "</div>";
    container.innerHTML = html;
  }

  /**
   * Format an ISO datetime string into a short "HH:MM" time label.
   *
   * @param {string} iso - ISO 8601 datetime string.
   * @returns {string} Locale-formatted time, or the original string on error.
   */
  function formatEventTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return iso;
    }
  }

  // -----------------------------------------------------------------------
  // Auto-load today's calendar events when the page first loads
  // -----------------------------------------------------------------------
  // Use a short delay so Bootstrap's tab JS is initialised first.
  setTimeout(function () {
    // Pre-load today's events in the background so they are ready when the
    // user switches to the Calendar tab.
    fetchAndRenderEvents({ timeframe: "today" }, "Today\u2019s Events").catch(
      function () { /* errors already handled inside fetchAndRenderEvents */ }
    );
    _calendarLoaded = true;
  }, 300);

})();
</script>

</body>
</html>`;
}
