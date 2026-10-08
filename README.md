# Postmark

Probabilistic read receipts and link-click tracking for Gmail: a Chrome (MV3) extension plus a small self-hosted server.

> **Status: v0.1.0 (developer preview).**

## What works / what's flaky / what's next

**Works (verified by 260+ automated tests, a headless-Chrome load of the built extension, and live server runs):**
- Server: auth, messages, events, accounts, reminders, `DELETE /v1/me`; pixel and redirect with classification (Gmail proxy / Apple MPP / bot / sender), dedupe, per-account self-open suppression, settle-window polling cursor, rate limits, retention. Docker image builds and serves.
- Extension: the send-path rewrite (links, pixel, disclosure line, quotes untouched, idempotent across Undo Send, fail-soft in ≤ 3 s); service-worker polling, notifications, reminders and the multi-account tab scope; popup and options in every state, light and dark. Tested end-to-end against the real server with a mocked Gmail adapter.
- Demo: `npm run seed` + `npm run simulate` show opens, auto-loads, bot exclusion and self-view suppression without a second inbox.

**Flaky / unverified:**
- **Not yet exercised in live Gmail.** This environment has no Gmail session. The InboxSDK hooks were written against InboxSDK 2.2.27's typings and are break-tested with a mocked SDK, but the compose button, list marks and thread strip have not been seen in a real Gmail tab. Start with the [manual checklist](#manual-test-checklist-gmail).
- The InboxSDK dev placeholder app id may show a warning, or be refused by InboxSDK. Register a free id if Gmail hooks don't appear.
- Open detection is heuristic by nature (MPP, proxy caching, scanners). See [Known limitations](#known-limitations).

**Next:** Google OAuth sign-in via `chrome.identity`, push instead of polling, a background re-bind for sends whose `sent` event was missed, and a Gmail-API-based reply check for "no reply" reminders.

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
| `EXTENSION_IDS` | *(empty = any extension, dev only)* | server CORS |
| `TRUST_PROXY` | `false` | server: honour `X-Forwarded-For` |
| `DEV_ALLOW_TOKEN_ROTATION` | `false` | server: dev only |
| `APPLE_MPP_CIDRS` | `17.0.0.0/8` | server: Apple MPP egress ranges |
| `IP_HASH_SALT` | *(random, stored in DB)* | server |
| `RETENTION_DAYS` | `0` (keep) | server: delete tracked messages and events older than N days |
| `VITE_POSTMARK_SERVER` | `http://localhost:8787` | extension build: default server URL (changeable in Options) |
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

In production, put the server behind an https reverse proxy and set `TRUST_PROXY=true`. Without it (for example plain Docker port mapping), every request appears to come from one IP, which weakens dedupe and the unique-open counts. Set `EXTENSION_IDS` to your extension id so CORS accepts only it.

## Build and load the extension

```bash
npm run build -w extension               # → extension/dist
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist`.
2. The options page opens. Enter an email and click **Register**, or use **Connect with an existing token** (see the demo below).
3. Open Gmail and reload the tab.

For tracking with real recipients the server must be reachable from the internet over https. See [Deploy for free on Cloudflare](#deploy-for-free-on-cloudflare-recommended-247-permanent-address).

## Deploy for free on Cloudflare (recommended: 24/7, permanent address)

Real read receipts need a server that recipients' mail apps can reach at any hour. The easiest free option is Cloudflare Workers with its D1 database: free tier, no credit card, always on, a permanent `https://postmark.<you>.workers.dev` address, and no machine of yours needs to stay awake. One person's tracking uses a tiny fraction of the free limits (about 100,000 requests a day).

One-time setup:

```bash
npx -w server wrangler login                               # opens the browser; create a free account if needed
npm run deploy:cloudflare -- --email you@gmail.com         # creates the database, sets it up, deploys
```

The script prints your server address. Then, in Chrome:

1. Postmark → **Options** → **Server URL** → paste the address → **Save server** (allow Chrome's permission prompt).
2. **Register** with the same email you passed to the deploy command. Only that email can register on your server.
3. Reload your Gmail tabs.

That's it. Nothing needs restarting, and your Mac can be off.

- **Redeploy after code changes:** run the same `npm run deploy:cloudflare` command again. Your data is kept.
- **Lost your login** (e.g. you reinstalled the extension): `npm run cf:reset-token -- --email you@gmail.com`, then paste the token into Options → *Connect with an existing token*.
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

Mail merge, scheduled send, snooze, templates, Outlook/Yahoo support, team accounts, billing, Firefox/Safari builds, OAuth sign-in, a server-side retention policy, push instead of polling.
