/**
 * Setup wizard UI for the Chalie Google Interface daemon (block protocol).
 *
 * Returns a block array that walks the user through creating a Google Cloud
 * project, enabling APIs, and entering OAuth credentials. The form submission
 * and auth status polling are handled via execute capabilities through the
 * gateway — no direct daemon port access needed.
 *
 * @module
 */

import type { Block } from "../../_sdk/blocks.ts";
import {
  section, header, text, code, list, form, input, actions, button,
  divider,
} from "../../_sdk/blocks.ts";

/** Port the OAuth callback server listens on (must match `auth.ts`). */
const CALLBACK_PORT = 9004;

/** The exact redirect URI that must be registered in Google Cloud Console. */
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth/callback`;

/**
 * Render the setup wizard as blocks.
 *
 * @returns Block array for the setup wizard UI.
 */
export function renderSetupWizard(): Block[] {
  return [
    section([
      header("Connect Your Google Account", 2),
      text("Follow the steps below to link Gmail and Google Calendar with Chalie. This only needs to be done once.", "plain"),

      divider(),

      // Step-by-step guide
      section([
        text("**Step 1 — Create a Google Cloud project**", "markdown"),
        list([
          "Go to console.cloud.google.com/projectcreate",
          "Enter a project name (e.g. Chalie Integration)",
          "Click Create and wait for it to finish",
          "Make sure your new project is selected in the dropdown",
        ], "ordered"),

        divider(),

        text("**Step 2 — Enable Gmail and Calendar APIs**", "markdown"),
        list([
          "Open the Gmail API page and click Enable",
          "Open the Google Calendar API page and click Enable",
        ], "ordered"),

        divider(),

        text("**Step 3 — Configure the OAuth consent screen**", "markdown"),
        list([
          "Go to APIs & Services → OAuth consent screen",
          "Select External user type, then click Create",
          "Fill in App name, User support email, and Developer contact email",
          "On Scopes screen, click Save and Continue (no scopes needed)",
          "On Test users screen, click + Add Users and enter your Gmail address",
          "Review the summary and click Back to Dashboard",
        ], "ordered"),

        divider(),

        text("**Step 4 — Create an OAuth 2.0 client ID**", "markdown"),
        list([
          "Go to APIs & Services → Credentials",
          "Click + Create Credentials → OAuth client ID",
          "For Application type, choose Desktop app",
          "Give it any name, then click Create",
          "Copy your Client ID and Client Secret — paste them below",
        ], "ordered"),

        divider(),

        text("**Redirect URI** (for reference — handled automatically for Desktop app clients):", "markdown"),
        code(REDIRECT_URI),
      ], "Setup Guide", true),

      divider(),

      // Credentials form
      section([
        header("Enter Your OAuth Credentials", 3),
        form("credentials-form", [
          input("client_id", { placeholder: "Client ID (e.g. 1234567890-abc.apps.googleusercontent.com)" }),
          input("client_secret", { placeholder: "Client Secret (e.g. GOCSPX-...)", type: "password" }),
          actions(
            button("Save & Connect with Google", {
              execute: "_setup_save_credentials",
              collect: "credentials-form",
              openUrl: true,
            }),
          ),
        ]),
      ]),
    ]),
  ];
}
