# Postmark on iOS Gmail — work outline

## Context

Postmark today is a Chrome MV3 extension + Hono server (Cloudflare Workers/D1 or Node/SQLite). The iOS Gmail app can't run browser extensions or content scripts, so none of the InboxSDK code (`extension/src/gmail/*`) can run there.

Mailsuite gets onto iOS by shipping a second product: a **Google Workspace add-on** ("Email tracker for mobile"). It runs inside the Gmail iOS/Android apps and, according to its Marketplace listing, needs the desktop extension too.
- **Sending:** compose → ⋯ → "Insert from Mailtrack" → "Track email". The add-on's compose action inserts the tracking pixel into the draft.
- **Viewing:** open a sent email → tap the add-on icon under "Available add-ons" → a card shows the tracking status.

Postmark can follow the same pattern and reuse the existing server, schemas and open classifiers. The main new piece is a Workspace add-on. The platform has hard limits that shape the plan:

| Desktop feature | What a Gmail add-on can do on iOS |
|---|---|
| Automatic tracking on send | ❌ No send hook. The user has to tap "Track email" for each message. |
| Rewrite every link in the body | ❌ Compose actions can only **insert** content at the cursor or at the top/bottom. They can't edit existing body HTML. Link tracking on mobile is limited to an "Insert tracked link" card. |
| Pixel in the body | ✅ Via `UpdateDraftBodyAction` / `insertContent` with HTML |
| ✓✓ marks in the Sent list | ❌ Add-ons can't change Gmail's lists |
| Tracking strip in the thread | ⚠️ Only as a card, after the user taps the add-on icon |
| Push notifications | ❌ Add-ons can't push. Use desktop notifications or another channel (phase 4). |
| Reminders | ✅ Created from a card. They still fire through the desktop extension or a server-side channel. |
| Sender self-open suppression | ⚠️ The iOS app loads the pixel through GoogleImageProxy, so the existing `?s=` signature trick can't work there |

## Recommended approach

Add a fourth workspace, `/addon`: a Gmail Workspace add-on written in TypeScript, built for **Apps Script** and deployed with `clasp`. It talks to the existing server over the existing Bearer-token API. Choosing Apps Script over an HTTP-runtime add-on hosted on the Worker means Google handles OAuth and the card rendering, and the first version needs no GCP project or Marketplace review. A test deployment installs on your own account, and that includes the iOS app.

### Phase 1 — Server changes (small, reuse existing code)
- **Account pairing:** `/v1/auth/register` is dev-grade (unverified email), so the add-on must not get a token just by knowing an email address. Pairing works like this:
  - `POST /v1/auth/pair-code` (authenticated, called from the options page) returns a short-lived 8-character code.
  - `POST /v1/auth/pair` {code} returns a new device token tied to the same user.
  - Tokens get a `device`/`client` label. Revoking one must not affect the others. This needs a `tokens` table, or `token_hash` moves out of `users`.
- **Message source:** `POST /v1/messages` gets an optional `client: 'extension' | 'addon'` field. Add it to the zod schema in `shared/src/schemas.ts` and to the DDL for both the D1 and SQLite migrations.
- **Late binding:** the add-on never sees a "sent" event. Add `POST /v1/messages/bind-by-pixel` {pixelId, gmailThreadId, gmailMessageId} and let it bind from the read-view card (Phase 2). Keep the existing `PATCH /v1/messages/:id`.
- **Mobile self-opens:** when the add-on card is opened on a message, it calls `POST /v1/messages/:id/sender-view`. Opens through the Gmail proxy within N seconds after that get classified as `sender`. Implement this in `server/src/tracking/classify.ts` next to `senderSigValid`, and document it in `docs/OPEN_DETECTION.md`.
  - Caveat: if you scroll a sent mail on iOS without opening the add-on, the open still counts. This is a known limitation.
- **Tests:** add vitest coverage for the pairing flow, bind-by-pixel and the sender-view window.

### Phase 2 — The add-on (`/addon`)
- **Manifest** (`appsscript.json`):
  - Triggers: `gmail.composeTrigger` (selectActions: "Track this email", "Insert tracked link"), `gmail.contextualTriggers` (on message open), and a `homepageTrigger`.
  - Scopes: `gmail.addons.execute`, `gmail.addons.current.action.compose`, `gmail.addons.current.message.metadata` (plus `.readonly` only if bind-by-pixel needs the body), `script.external_request`, `userinfo.email`.
  - `urlFetchWhitelist`: the server origin.
- **Homepage card:** pair with code (token stored in `PropertiesService.getUserProperties()`), show server URL and connection status, unpair.
- **Compose action "Track this email":**
  1. Read the sender from `Session.getActiveUser()` / the draft's From address, normalized with `normalizeAccount` from `shared/src/accounts.ts`.
  2. Call `POST /v1/messages` with `links: []`. The subject and recipients come from the compose event's draft metadata.
  3. Return an `UpdateDraftActionResponse` that inserts the pixel `<img>`, and the disclosure line when that setting is on, at the end of the body.
  4. Generate this HTML by extracting a pure `pixelHtml()`/`disclosureHtml()` from `extension/src/compose/rewriteBody.ts` into `/shared`, so the pixel markup is identical and `hasPostmarkPixel` still dedupes.
  5. If the call fails, show a notification card: "Not tracked — server unreachable".
- **Compose action "Insert tracked link":** a form for the URL and link text. It registers the link and inserts an `<a>` at the cursor. This needs a server endpoint to add links to a message, or creates the message on first use.
- **Read-view contextual card**, for messages the user sent:
  1. Look the message up by Gmail message/thread ID. If it isn't bound yet, read the body, find the `data-postmark` pixel, bind by pixel, and fire sender-view.
  2. Show the same data the thread strip shows: status, opens (first/last), per-link clicks, "Possibly auto-loaded", and the activity history from `GET /v1/messages/:id/events`.
  3. Add a "Remind me" section (1/3/7 days or custom, no-open/no-reply) that posts to `/v1/reminders`.
  4. Wording must stay probabilistic ("Opened (estimate)"), as section 8 requires.
- **Build and tests:**
  - esbuild bundles `/addon/src` plus `/shared` into a single Apps Script file.
  - Apps Script globals (`UrlFetchApp`, `CardService`, `PropertiesService`) sit behind a thin `gas.ts` adapter so card builders and the API client can be unit-tested with vitest.
  - Add `addon` to the root `npm run verify`.

### Phase 3 — Extension changes
- Options page: a "Mobile (Gmail app)" section with a "Generate pairing code" button and a list and revoke control for paired devices.
- The popup, Sent-list marks and thread strip already read from the server, so mobile-sent mail appears on desktop once it's bound. Add a small "📱 sent from phone" chip using `client`.
- Desktop notifications already cover mobile-sent mail through `/v1/events` polling, which is how Mailsuite's mobile add-on relies on its desktop piece.

### Phase 4 — Phone notifications (optional; Mailsuite doesn't do this either)
Pick one:
- **ntfy.sh / Pushover:** the server POSTs to a user-configured topic. Simplest option.
- **iOS 16.4+ Web Push** from a tiny home-screen PWA served by the Worker. Uses VAPID; the Worker cron already exists for reminders.

Either way it needs a settings toggle and has to respect quiet hours via `resolveSettings` in `shared/src/settings.ts`.

### Phase 5 — Distribution and docs
- For personal use, do a test deployment from the Apps Script editor (Deploy → Test deployments → Install). For Google Workspace accounts, the admin may need to allow the add-on.
- Publishing publicly needs the Workspace Marketplace SDK, a GCP project and OAuth consent verification. The `gmail.addons.current.message.*` scopes are sensitive and require review. Document this and don't do it now.
- Docs:
  - Add `docs/MOBILE_ADDON.md`, covering each trigger, its scopes, how to debug (Apps Script executions log), and the limitations table above.
  - Update the README with setup steps, a manual iOS checklist and known limitations.
  - Record the Apps Script vs. HTTP-runtime choice in `docs/DECISIONS.md`.

## Critical files
- New: `addon/` (`appsscript.json`, `src/{compose,contextual,homepage,api,gas}.ts`, build script, tests)
- `shared/src/schemas.ts`, `shared/src/constants.ts`: pairing and bind schemas, `client` field
- New `shared/src/pixel.ts`: pixel and disclosure HTML moved out of `extension/src/compose/rewriteBody.ts`
- `server/src/routes/api.ts`, `server/src/tracking/classify.ts`, the DB layer and migrations (both D1 and SQLite)
- `extension/src/ui/options/*`: pairing UI
- Root `package.json`: workspace and `verify`

## Verification
1. `npm run verify` stays green, including the new addon unit tests and the server tests for pairing, bind-by-pixel and sender-view.
2. `clasp push`, then install the test deployment, then pair from the options page.
3. On an iPhone, send a tracked email from the Gmail app:
   - The pixel is present in the received message source.
   - `npm run simulate`, or a real open from another inbox, shows up in the add-on card and in the desktop popup and notifications.
   - Opening the add-on card on your own sent mail doesn't create a counted open.
4. Insert a tracked link on mobile, click it, and confirm the click shows up and the redirect only goes to the registered URL.

Sources: [Mailsuite blog — iOS/Android](https://mailsuite.com/blog/?p=5480), [Marketplace listing](https://workspace.google.com/marketplace/app/email_tracker_for_mobile_mailsuite/129668302705), [Compose-time add-on functions](https://developers.googleblog.com/en/enhancing-add-ons-in-gmail-with-compose-time-functions/), [Gmail add-ons docs](https://developers.google.com/workspace/add-ons/gmail)
