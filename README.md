# Postmark

Probabilistic read receipts and link-click tracking for Gmail: an MV3 extension for Chrome and Firefox plus a small self-hosted server.

> **Status: v0.2.1.** Verified end-to-end in live Gmail with the server on Cloudflare Workers (free, 24/7).

## What works / what's flaky / what's next

**Works (verified in live Gmail, plus ~300 automated tests, headless-Chrome checks and live server runs):**
- Server: auth, messages, events, accounts, reminders, `DELETE /v1/me`; pixel and redirect with classification (Gmail proxy / Apple MPP / bot / sender), dedupe, per-account self-open suppression, settle-window polling cursor, rate limits, retention. Docker image builds and serves.
- Extension: the send-path rewrite (links, pixel, disclosure line, quotes untouched, idempotent across Undo Send, fail-soft in ≤ 3 s); service-worker polling, notifications, reminders and the multi-account tab scope; popup and options in every state, light and dark. Tested end-to-end against the real server with a mocked Gmail adapter.
- Demo: `npm run seed` + `npm run simulate` show opens, auto-loads, bot exclusion and self-view suppression without a second inbox.

**Flaky / unverified:**
- Confirmed in live Gmail: compose eye toggle, tracked sends, real opens and clicks via the Cloudflare deployment, notifications, Sent-list marks, activity history. Edge cases on the [manual checklist](#manual-test-checklist-gmail) (aliases, multi-account, Undo Send, reminders) are covered by tests but worth a manual pass.
- **Firefox build:** confirmed working in live Gmail on Zen (Firefox 158 base), loaded as a temporary add-on. InboxSDK officially targets Chrome, so re-run the [Firefox checklist](#firefox) after InboxSDK or Firefox upgrades.
- Open detection is heuristic by nature (MPP, proxy caching, scanners). See [Known limitations](#known-limitations).

**Next:** Google OAuth sign-in via `chrome.identity`, push instead of polling, a background re-bind for sends whose `sent` event was missed, a Gmail-API-based reply check for "no reply" reminders, and optional per-recipient tracking for group emails.

- ✓ / ✓✓ marks in Gmail's Sent list (grey = sent, green = opened, amber = possibly auto-loaded), plus a link-click icon
- A "Tracking" strip under each of your tracked messages in a thread: opens (first/last), per-link clicks, and a **Remind me** button
- A popup dashboard (recent emails, reminders, account switcher, search) and an options page
- **Full activity history per email**: every open and click with its time and source (Gmail, mail app, Apple's auto-loading, security scanners, your own views), in the popup and in Gmail's tracking strip
- Desktop notifications on first open and on link clicks; follow-up reminders
- Multiple Gmail accounts in one Chrome profile, each scoped to its own tab
- Per-email toggle (eye icon in the compose toolbar), per-account and global defaults, and an optional disclosure line

> Open tracking is **an estimate, never proof of reading**. See [Known limitations](#known-limitations).

## Repository layout

| Path | What |
|---|---|
| `shared/` | zod schemas, types, the settings resolver and the message-bus types, used by both sides |
| `server/` | Hono tracking server. Runs on **Cloudflare Workers + D1** (`src/worker.ts`, free 24/7) or Node + better-sqlite3 (`src/index.ts`, port 8787, Dockerfile) |
| `extension/` | MV3 extension (Vite + CRXJS, Preact, InboxSDK) |
| `scripts/` | `deploy-cloudflare.mjs`, `cf-reset-token.mjs`, `seed.ts`, `simulate-open.ts`, `gen-icons.mjs` |
| `docs/` | plans, decisions, open-detection heuristics, Gmail integration guide, reviews |

## Setup

> **Just want to use Postmark?** Follow [Deploy for free on Cloudflare](#deploy-for-free-on-cloudflare-recommended-247-permanent-address). It walks through everything from cloning to your first tracked email. This section is the developer setup.

Requirements: Node ≥ 20, npm ≥ 10, Chrome ≥ 116. Docker is optional.

```bash
npm install
cp .env.example .env        # optional: adjust values
npm run verify              # typecheck, lint, format check, all tests, both builds
```

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `8787` | server |
| `PUBLIC_BASE_URL` | *(origin of each request)* | server: base for pixel/link URLs. **Must be internet-reachable over https for real recipients.** Not needed on Cloudflare. |
| `ALLOWED_EMAILS` | *(empty = anyone may register)* | server: comma-separated emails allowed to register |
| `DATABASE_PATH` | `./data/postmark.db` | server |
| `EXTENSION_IDS` | *(empty = any extension, dev only)* | server CORS: Chrome extension ids and/or Firefox internal UUIDs, comma-separated |
| `TRUST_PROXY` | `false` | server: honour `X-Forwarded-For` |
| `DEV_ALLOW_TOKEN_ROTATION` | `false` | server: dev only |
| `APPLE_MPP_CIDRS` | `17.0.0.0/8` | server: Apple MPP egress ranges |
| `IP_HASH_SALT` | *(random, stored in DB)* | server |
| `RETENTION_DAYS` | `0` (keep) | server: delete tracked messages and events older than N days |
| `VITE_POSTMARK_SERVER` | `http://localhost:8787` | extension build: default server URL (changeable in Options) |
| `VITE_GECKO_ID` | `postmark-dev@postmark.local` | Firefox build: add-on id (use your own, e.g. `postmark@yourdomain`, before signing) |
| `VITE_INBOXSDK_APP_ID` | `sdk_POSTMARK_DEV_PLACEHOLDER` | extension build: register a free id at <https://www.inboxsdk.com/register> |

## Run the server

```bash
npm run dev:server                       # tsx watch, http://localhost:8787
# or
npm run build -w server && npm start -w server
# or
docker compose up --build                # data persisted in the postmark-data volume
```

`GET /healthz` returns `{"ok":true}`.

In production, put the server behind an https reverse proxy and set `TRUST_PROXY=true`. Without it (for example plain Docker port mapping), every request appears to come from one IP, which weakens dedupe and the unique-open counts. Set `EXTENSION_IDS` to your extension id so CORS accepts only it. For Firefox, add the add-on's **Internal UUID** (about:debugging → This Firefox → Postmark). Firefox generates it per install, so update it after reinstalling.

## Build and load the extension

```bash
npm run build -w extension               # → extension/dist/chrome and extension/dist/firefox
npm run build:chrome -w extension        # or just one target
```

### Chrome

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist/chrome`.
2. The options page opens. Enter an email and click **Register**, or use **Connect with an existing token** (see the demo below).
3. Open Gmail and reload the tab.

### Firefox

Needs Firefox 140 or later (ESR 140 works).

- **Try it:** `npm run run:firefox -w extension` starts a throwaway Firefox profile with the add-on loaded and Gmail open. Or open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and pick `extension/dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox quits.
- **Install permanently (self-signed, unlisted):** release Firefox only installs signed add-ons. Signing an *unlisted* add-on is free, automatic and doesn't publish anything:
  1. Set `VITE_GECKO_ID=postmark@<something-you-own>` in `.env` and rebuild (`npm run build:firefox -w extension`). The id must stay the same across versions.
  2. Create API credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
  3. `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npm run sign:firefox -w extension`. The signed `.xpi` lands in `extension/dist/xpi/`. Open it in Firefox to install.
  4. Bump `version` in `extension/package.json` before signing again: AMO rejects a version it has already signed.
- **Permissions:** Firefox lets you withhold or revoke the Gmail and server permissions (about:addons → Postmark → Permissions). If one is missing, Options and the popup show a banner with a one-click fix.

For tracking with real recipients the server must be reachable from the internet over https. See [Deploy for free on Cloudflare](#deploy-for-free-on-cloudflare-recommended-247-permanent-address).

## Deploy for free on Cloudflare (recommended: 24/7, permanent address)

Real read receipts need a server that recipients' mail apps can reach at any hour. The easiest free option is Cloudflare Workers with its D1 database: free tier, no credit card, always on, a permanent `https://postmark.<you>.workers.dev` address, and no machine of yours needs to stay awake. One person's tracking uses a tiny fraction of the free limits (about 100,000 requests a day).

Each person who uses Postmark this way runs their own server in their own Cloudflare account. Your data stays in your account.

### Start to finish

**You need:** Node ≥ 20 and npm ≥ 10 (`node -v`, `npm -v`), git, Chrome ≥ 116 (or Firefox ≥ 140), and a free Cloudflare account (you can create it in step 3).

**1. Get the code and install dependencies**

```bash
git clone https://github.com/ZacharyYW/postmark.git
cd postmark
npm install
cp .env.example .env
```

**2. Set the InboxSDK app id in `.env`**

Postmark uses InboxSDK to hook into Gmail, and it needs an app id. Register a free one at <https://www.inboxsdk.com/register> (sign in with Google, give the app a name, copy the `sdk_…` id). You can also use an id someone else gives you: it isn't a secret, and it gives no access to Gmail or to your server.

```
VITE_INBOXSDK_APP_ID=sdk_yourIdHere
```

Leave the rest of `.env` alone. The server section is only for running the server locally; Cloudflare ignores it.

**3. Log in to Cloudflare**

```bash
npx -w server wrangler login        # opens the browser; sign up for free if you have no account
```

**4. Deploy the server**

```bash
npm run deploy:cloudflare -- --email you@gmail.com
```

Use the email you'll register with in step 7. Only that email can register on your server. The script creates the database, sets it up, deploys the Worker and prints your server address, `https://postmark.<subdomain>.workers.dev`. Copy it.

> **First deploy on a new Cloudflare account:** the script may stop at step 4/5 with *"your Cloudflare account needs a workers.dev subdomain"*. That's a one-time naming step:
> 1. Open the link the script printed (or dash.cloudflare.com → **Workers & Pages**) and set the **subdomain**. If the dashboard insists on creating a Worker first, pick **Start from Hello World** and deploy it. You can delete it afterwards. Don't pick *Connect GitHub* or *Upload static files*: the script deploys the real Worker itself.
> 2. Re-run the same `npm run deploy:cloudflare` command. It reuses the database it already created.
> 3. If the health check says "not reachable yet", wait a minute. DNS for a new subdomain takes a moment.
>
> **Choose the subdomain carefully.** It appears in every tracked email's pixel and link URLs, so recipients can see it: use something neutral, not your name. Don't change it later either. Emails sent with the old address stop reporting opens and clicks.

**5. (Optional) Build your server address into the extension**

Set `VITE_POSTMARK_SERVER=https://postmark.<subdomain>.workers.dev` in `.env` so new installs start pointed at your server. If you skip this, you'll paste the address into Options in step 7.

**6. Build and load the extension**

```bash
npm run build -w extension
```

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select `extension/dist/chrome`. Keep that folder; Chrome loads the extension from it.
- **Firefox:** see [Firefox](#firefox).

**7. Connect the extension to your server**

1. Postmark's **Options** page opens (or right-click the Postmark icon → **Options**).
2. **Server URL** → paste your `workers.dev` address → **Save server** → allow the permission prompt.
3. Enter the email from step 4 → **Register**.
4. Reload your Gmail tabs.

**8. Check it works**

Compose an email in Gmail. The compose toolbar has an eye icon (tracking on). Send it to another address you can read, open it there, and within about a minute you'll see a green ✓✓ in your Sent list and a desktop notification.

That's it. Nothing needs to keep running on your computer, and it can be off.

### Use the same account on another computer or browser

All installs that share a login token share one account: the same tracked emails, opens and reminders. The server only stores a hash of the token, so you copy it from an install that's already logged in.

**Get your token (from a logged-in install):**

1. Open Postmark → **Options** on that install.
2. Right-click the page → **Inspect** → **Console**. Use the Options page's console (or `chrome://extensions` → Postmark → *service worker*), not Gmail's: other pages can't read extension storage.
3. Run:
   ```js
   chrome.storage.local.get('auth').then(r => console.log(r.auth.token))
   ```
   If Chrome refuses to paste, type `allow pasting`, press Enter, and paste again.
4. Copy the printed string (without the quotes).

The token is a password for all your tracking data. Don't post it or share it, and don't give it to someone else so they can "use your account": they'd see all your tracked emails and you'd see theirs.

**No install logged in any more** (e.g. you reinstalled)? Issue a new token from the repo folder:

```bash
npm run cf:reset-token -- --email you@gmail.com
```

This **replaces** the old token, so every install that was logged in gets logged out. Paste the new one into all of them.

**Connect the other install:**

1. **Options** → **Server URL** → the same `workers.dev` address → **Save server**.
2. Open **Connect with an existing token** → paste the token → **Connect**.
3. Reload your Gmail tabs.

Each install raises its own desktop notifications, so with Postmark on two computers you get each alert on both.

### Maintenance

- **Redeploy after code changes:** run the same `npm run deploy:cloudflare` command again. Your data is kept.
- **Update the extension:** `git pull`, `npm install`, `npm run build -w extension`, then click the reload icon on Postmark in `chrome://extensions`.
- **Try the Cloudflare build locally first:** `npm run cf:dev` (local database, http://127.0.0.1:8788).
- **Limits to know:** the free plan's rate limiting runs per Cloudflare instance (best effort), and the history is stored in D1 (5 GB free). See `docs/DECISIONS.md` D-025…D-028.

### Alternative: your own machine plus a tunnel (for development)

1. `brew install cloudflared`, then `cloudflared tunnel --url http://localhost:8787`, and copy the `https://….trycloudflare.com` address.
2. In `.env` at the repo root set `PUBLIC_BASE_URL=https://<that-address>` and `TRUST_PROXY=true`, then restart `npm run dev:server`.

Quick-tunnel addresses change whenever `cloudflared` restarts, and emails sent earlier stop reporting opens, so use the Cloudflare deployment above for everyday use.

## Demo without a second inbox

```bash
npm run dev:server        # terminal 1
npm run seed              # terminal 2: demo user, 2 sender accounts, opens/clicks, a reminder
npm run simulate          # hits the latest message's pixel with Gmail-proxy / Apple MPP / bot / … UAs
npm run simulate -- --account alex.work@example.com --click
```

`seed` prints a token (also saved to `.postmark-demo-token`). Paste it into **Options → Connect with an existing token** and open the popup to see the demo data.

## Manual test checklist (Gmail)

Before you start: the server is running, the extension is loaded, you're signed in on the options page, and Gmail is reloaded.

**Compose & send**
- [ ] A compose window shows the Postmark eye icon in its toolbar, filled (on) by default. Its tooltip reads "Postmark tracking is ON…".
- [ ] Clicking the eye toggles it to struck-through (off). Send: the message is sent with no pixel (check "Show original" on the recipient side).
- [ ] With tracking on, send to another address you control. In the recipient's "Show original", links point to `<server>/l/…` and there's a `<server>/p/….gif` image. The link text is unchanged.
- [ ] Reply to a thread containing links. Only links you typed are rewritten; quoted links are untouched.
- [ ] Stop the server and send: the email goes out normally within ~3 s and the toast "Sent without tracking" appears.
- [ ] Switch the compose "From" to a "Send as" alias. The popup shows the message with the alias as its account.
- [ ] Plain-text mode: the email sends untracked and the toast explains why.
- [ ] Undo Send, then send again: the popup shows **one** tracked message.

**Sent list & thread view**
- [ ] In Sent, the tracked message shows a grey ✓✓ ("Postmark: sent, not opened yet").
- [ ] Open the email as the recipient (another account or device). Within ~1–2 min the mark turns green, and its tooltip shows the count and the last-open time.
- [ ] Open the sent message yourself: a "Tracking" strip appears above the body. Your own view does **not** count as an open.
- [ ] Click a tracked link as the recipient: a link icon with a count appears in the list, and the strip shows per-link clicks.
- [ ] The strip collapses and expands, and the state persists across threads. Keyboard: Tab to "Tracking", press Enter.
- [ ] "Remind me": choose 3 days, "if not opened". The popup's Reminders tab lists it.

**Multi-account**
- [ ] Open Gmail as account A (`/u/0`) and account B (`/u/1`). Send a tracked email from each.
- [ ] A's Sent list shows marks only for A's messages, and B's only for B's.
- [ ] Send from A to B, then open it in B's tab. It counts as an open (B is a recipient), and B's tab shows no strip for A's message.
- [ ] Popup: "All accounts" shows "via …" chips. With A's Gmail tab active, the popup preselects A.
- [ ] Options: both accounts are listed. Set B's notifications to Off, then an open of B's mail produces no notification.

**Notifications & reminders**
- [ ] A first open triggers one desktop notification. With more than one account it names the account ("via …"). Clicking it opens the thread under the right account.
- [ ] A burst of opens doesn't produce a burst of notifications.
- [ ] Quiet hours (Options) hold notifications and show a summary afterwards.
- [ ] To test reminders quickly, create one, then in the SW console run `chrome.alarms.create('pm-rem:<id>', {when: Date.now()+1000})`.

**Firefox**<a id="firefox"></a> (repeat the compose, Sent-list and notification checks above, then:)
- [ ] The eye icon, Sent-list marks and Tracking strip all appear. If none of them do, check the Gmail tab's console for "InboxSDK failed to load" (see `docs/GMAIL_INTEGRATION.md`).
- [ ] DevTools → Network on the Gmail tab shows **no** requests to `api.inboxsdk.com`: the telemetry guard works in Firefox's content-script sandbox.
- [ ] Notifications show the "via account" line inside the message text.
- [ ] Revoke "Access your data for mail.google.com" in about:addons. The popup and Options show the permission banner, and **Grant access** restores it.
- [ ] Quit and restart Firefox: polling and reminders resume (event page, not a service worker).

**Popup & options states**
- [ ] Signed out shows "Sign in to Postmark". Server stopped shows "Can't reach your Postmark server". A new user with no data shows "No tracked emails yet".
- [ ] Dark mode (OS setting) is applied to the popup, options page and Gmail strip.

## Known limitations

- **Image blocking**: recipients who don't load images never register an open. "Not opened" doesn't mean unread.
- **Apple Mail Privacy Protection** prefetches images, so Apple Mail recipients can look "opened" when no one read the email. Postmark labels likely prefetches "possibly auto-loaded" and excludes them from counts and notifications, but later MPP re-fetches can still look like real opens.
- **Image proxies and caching**: Gmail fetches images through its proxy and may cache them despite `no-store`, so repeat-open counts are a lower bound.
- **Self-opens elsewhere**: opening your own sent mail on a phone or in a browser without the extension looks like a recipient open.
- **Link scanners** (Safe Links, Proofpoint, …) are filtered by user agent and timing, which is heuristic.
- **"No reply" reminders** only know about replies the extension has seen in Gmail.
- **Delegated / shared mailboxes**: marks show in the tab whose account (or alias) matches the From address.
- See [`docs/OPEN_DETECTION.md`](docs/OPEN_DETECTION.md) for every heuristic.

## Privacy & legal

- The extension sends the server only the **subject, recipient addresses, tracked URLs and sending account** of each tracked email. **Never the body.** It talks to no one else: no analytics, ads or third-party calls. InboxSDK's built-in telemetry to its vendor is blocked inside the extension (see `docs/REVIEW-2-security.md`).
- The server stores salted IP hashes and a coarse client class, never raw IPs or user agents. **Options → Delete my data** erases everything server-side.
- Email tracking may require consent or disclosure depending on where you and your recipients are (e.g. ePrivacy/GDPR in the EU/UK, various US state laws). **You are responsible for compliance.** The optional disclosure line ("Read receipts enabled") can help.
- Auth is **dev-grade** (email + bearer token, no verification). The production plan is Google OAuth via `chrome.identity` (see `docs/DECISIONS.md` D-006).

## Future work (out of scope for v1)

Mail merge, scheduled send, snooze, templates, Outlook/Yahoo support, team accounts, billing, Safari build, Firefox for Android, OAuth sign-in, a server-side retention policy, push instead of polling.
