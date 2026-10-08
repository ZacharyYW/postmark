# CLAUDE CODE PROMPT — "Postmark": a Mailsuite-style Gmail tracking extension

You are building **Postmark**, a Chrome (Manifest V3) extension plus a small tracking backend. It does what Mailsuite/Mailtrack does inside Gmail: it tells a sender when and how often their email was opened, which links were clicked, and it nudges them to follow up. Build the whole thing in this repo, in one autonomous run, following the 9-stage process in section 9. Do not ask me questions. When something is ambiguous, pick the default stated here, record it in `docs/DECISIONS.md`, and keep going.

---

## 1. Product summary

Postmark adds email tracking to Gmail (mail.google.com) for the signed-in user.

- When composing, the user sees a **tracking toggle** (on by default). With it on, Postmark inserts a 1x1 tracking pixel and rewrites links on send.
- In the **Sent** list and in thread view, each tracked message shows status marks: ✓ sent, ✓✓ opened (grey = sent, green = opened), plus a link-click indicator.
- A **popup dashboard** lists recent tracked emails with open/click counts and timestamps.
- Users get **desktop notifications** on first open and on link clicks.
- Users can set a **follow-up reminder** ("remind me if no reply/open in N days").

Name, colors and branding are original. Do not copy Mailsuite/Mailtrack logos, text or assets.

## 2. Scope

**In scope (must ship):**
1. Open tracking (pixel), with first-open and repeat-open events.
2. Link click tracking (redirect through the backend).
3. Gmail UI integration: compose toggle, Sent-list marks, thread-view tracking panel.
4. Popup dashboard + options page.
5. Desktop notifications (first open, link click), configurable.
6. Follow-up reminders (`chrome.alarms` + notification + optional Gmail deep link back to the thread).
7. Per-email and global tracking opt-out; optional visible disclosure footer line ("Read receipts enabled"), default OFF, user-toggleable.
8. Backend with auth, persistence, rate limiting, and tests.
9. **Multi-account support:** one install and one Postmark user can track mail sent from several Gmail accounts (multiple accounts in one Chrome profile, e.g. `/u/0` and `/u/1` in different tabs). Every tracked message records which Gmail account sent it, and all Gmail-facing UI is scoped to the account active in the current tab (see 6.6).

**Out of scope (list in README as "future work", do not build):** mail merge, scheduled send, snooze, templates, Outlook/Yahoo support, team accounts, billing, Firefox/Safari builds.

## 3. Tech stack (fixed)

- Monorepo with npm workspaces: `/extension`, `/server`, `/shared`, `/docs`.
- Language: TypeScript (strict) everywhere.
- Extension: MV3, built with Vite + `@crxjs/vite-plugin` (or plain Vite multi-entry if CRXJS fails; note it in DECISIONS). UI: Preact + CSS modules (no heavy UI libs).
- Gmail integration: **InboxSDK** (`@inboxsdk/core`) for compose/list/thread hooks, with the app id read from `VITE_INBOXSDK_APP_ID` (default to a clearly marked dev placeholder). Wrap InboxSDK behind `extension/src/gmail/adapter.ts` so it can be swapped for raw DOM observation later.
- Server: Node 20, Hono, `better-sqlite3`, `zod` validation, `vitest` tests. Dockerfile and a `docker-compose.yml` for local run. Port 8787.
- Shared: zod schemas and TS types for API payloads and event types, imported by both sides.
- Lint/format: ESLint + Prettier. A root `npm run verify` must run typecheck, lint, tests, and both builds.

## 4. Architecture

```
Gmail tab (content script + InboxSDK)
   │  compose/send/list/thread events
   ▼
Service worker (background)  ◄── chrome.alarms, notifications, storage
   │  HTTPS (Bearer token)
   ▼
Tracking server (Hono + SQLite)
   ▲                         ▲
   │ GET /p/:id.gif          │ GET /l/:linkId
Recipient's mail client / Gmail image proxy
```

Rules:
- Content script never calls the server directly; it messages the service worker (typed message bus in `/shared`).
- Service worker owns the auth token (`chrome.storage.local`), API client, polling, and notifications.
- Polling: every 60s while a Gmail tab is open, every 5 min otherwise, via `chrome.alarms` (min 30s in MV3). No long-lived WebSockets in v1.

## 5. Backend spec

### 5.1 Data model (SQLite)
- `users(id, email, token_hash, created_at, settings_json)`
- `messages(id, user_id, sender_account, gmail_thread_id NULL, gmail_message_id NULL, subject, recipients_json, sent_at, tracking_enabled, pixel_id UNIQUE)` — `sender_account` is the lowercased Gmail address that sent the message; index `(user_id, sender_account, sent_at)`.
- `links(id, message_id, original_url, position)`
- `events(id, message_id, link_id NULL, type ENUM('open','click'), occurred_at, ip_hash, ua_class ENUM('gmail_proxy','apple_mpp','sender','bot','other'), is_first)`
- `reminders(id, message_id, remind_at, condition ENUM('no_open','no_reply','always'), status)`

Hash IPs with a per-install salt; never store raw IPs or raw user agents beyond the coarse `ua_class`.

### 5.2 API (all JSON, zod-validated, `Authorization: Bearer <token>` unless public)
- `POST /v1/auth/register` {email} → {token} (dev-grade: no email verification; mark TODO and document the production plan: Google OAuth via `chrome.identity`).
- `POST /v1/messages` {senderAccount, subject, recipients[], links[]} → {messageId, pixelUrl, rewrittenLinks[{original, trackedUrl}]}. Called at compose-send time.
- `PATCH /v1/messages/:id` {gmailThreadId, gmailMessageId} — bind after Gmail confirms the send.
- `GET /v1/messages?since=&limit=&account=` → messages with aggregated counts and last event; `account` optional (omit = all accounts).
- `GET /v1/accounts` → distinct sender accounts for this user with per-account message counts and per-account settings.
- `PATCH /v1/accounts/:account` {trackingDefault, notificationsEnabled} → per-account settings (stored in `settings_json`).
- `GET /v1/messages/:id/events`
- `GET /v1/events?since=<iso>&account=` → new events for notification polling (events carry `senderAccount`).
- `POST /v1/reminders`, `GET /v1/reminders`, `DELETE /v1/reminders/:id`.
- `DELETE /v1/me` — erase all user data.
- Public: `GET /p/:pixelId.gif` returns a 43-byte transparent GIF with `Cache-Control: no-store, max-age=0`, then records an open. `GET /l/:linkId` records a click and 302-redirects; only `http(s)` targets, reject others.

### 5.3 Open-detection rules (the hard part — implement carefully)
- **Self-open suppression:** ignore opens that occur within 10s of send, and opens from the sender's own session (extension adds a `?s=<signed-short-token>` param when it renders the sender's own view; or suppress when the request carries the sender's token cookie/header). Mark as `ua_class='sender'` and don't notify. Suppression is per sender account: viewing a sent message from account A must not mark it as a recipient open, and an open by account B (a different account of the same user, possibly a recipient of A's mail) must still count as a real open.
- **Gmail image proxy:** Gmail fetches images via `GoogleImageProxy`; classify as `gmail_proxy`, count as a real open. Proxy caching is why `no-store` headers matter.
- **Apple Mail Privacy Protection / prefetch:** classify likely prefetch (known proxy ranges UA heuristics + opens within seconds of delivery from a non-Gmail proxy) as `apple_mpp` and show as "Opened (possibly auto-loaded)" in UI, not counted toward "unique opens" for notifications.
- **Bots/scanners:** UA contains known scanner signatures → `bot`, excluded from counts.
- Dedupe: opens from the same `ip_hash+ua_class` within 30s collapse into one.
- Document every heuristic in `docs/OPEN_DETECTION.md` and unit-test each classifier with fixtures.

### 5.4 Security/privacy
- Rate limit public endpoints (token bucket per IP hash) and authenticated endpoints per user.
- CORS: allow only the extension origin and Gmail for authenticated routes; public routes are open.
- Pixel and link IDs are unguessable (nanoid, 21 chars). Redirect endpoint must not be an open redirect for arbitrary users: only URLs registered in `links` are redirectable.
- Helmet-style security headers; no secrets in repo; `.env.example` provided.

## 6. Extension spec

### 6.1 Manifest (MV3)
- Permissions: `storage`, `alarms`, `notifications`. Host permissions: `https://mail.google.com/*` and the server origin (from env).
- Service worker module, content script on `mail.google.com`, popup, options page. No remote code. Strict CSP.

### 6.2 How the UI interfaces with Gmail (implement exactly this)

**Compose window (via InboxSDK `registerComposeViewHandler`):**
0. Determine the sending account with InboxSDK `sdk.User.getEmailAddress()` (and the compose view's from-address when "Send as" aliases are used); include it as `senderAccount` on every API call. If it can't be determined, send untracked rather than guessing.
1. Add a toolbar button to the compose window: eye icon, tooltip "Tracking on/off". State is per-compose, defaulting to the global setting. Toggled-on shows a filled icon; off shows struck-through.
2. On `presending` (InboxSDK `composeView.on('presending', …)`):
   - If tracking is on: read the body HTML, collect all `<a href>` (skip `mailto:`, `tel:`, anchors, and links already pointing to the Postmark domain), ask the service worker for `POST /v1/messages`, replace link hrefs with `trackedUrl` (keep visible link text unchanged), and append the pixel `<img src=pixelUrl width="1" height="1" style="display:none" alt="">` at the end of the body (before the quoted reply block if any).
   - If the optional disclosure footer is enabled, append a small grey line.
   - Never block sending: if the server call fails or times out (3s), send untracked and show a non-blocking toast "Sent without tracking".
3. On `sent` (InboxSDK provides the message/thread ids): `PATCH` the message with the Gmail thread/message IDs.
4. Do not double-track: detect an existing Postmark pixel in the body (drafts, resends) and reuse/skip.
5. Replies/forwards: track only the newly typed portion's links; leave quoted content alone.

**Sent list (InboxSDK `Lists.registerThreadRowViewHandler`):**
- For rows whose thread ID matches a tracked message **and whose `senderAccount` matches the account active in this tab**, add a small right-aligned label/icon: grey ✓✓ → "Sent, not opened"; green ✓✓ → "Opened N times"; add a link icon with count if clicked. Tooltip shows last-opened time (relative + absolute). Refresh whenever new data arrives from the service worker without full re-render.

**Thread view (InboxSDK `registerThreadViewHandler` + message view):**
- Only for messages whose `senderAccount` matches the active tab's account (never show another account's tracking data in this tab). Under each tracked outgoing message header, inject a compact "Tracking" strip: opens (first/last time), per-link click counts, and a small "Possibly auto-loaded" note where applicable. Collapsible; remembers its state.
- Add a "Remind me" button there (opens a small popover: in 1 / 3 / 7 days or custom; condition: if no reply / if not opened).

**Styling:** Shadow DOM or namespaced CSS for everything injected so Gmail CSS can't leak in or out. Respect Gmail dark theme via `prefers-color-scheme` and Gmail's theme class where available. Keyboard accessible, ARIA labels on all injected controls.

**Resilience:** Gmail ships DOM changes often. All Gmail-touching code is isolated in `extension/src/gmail/*`, never hard-codes obfuscated class names directly (go through InboxSDK APIs), and fails soft: if a hook can't attach, log once and continue. Add a `docs/GMAIL_INTEGRATION.md` describing each hook, what it depends on, and how to debug.

### 6.3 Popup
- Tabs: Recent (last 50 tracked emails: recipient(s), subject, status, last event time), Reminders, Settings shortcut.
- **Account switcher** at the top: "All accounts" (default) plus each sender account from `/v1/accounts`. If a Gmail tab is open, preselect that tab's account. Each row shows a small account chip when "All accounts" is selected. Remember the last selection.
- Search/filter by recipient or subject. Click a row → open the thread in Gmail via the stored thread id.
- Empty, loading, error, and logged-out states all designed.

### 6.4 Options page
- Server URL, Postmark login (register/logout/delete my data), a **Gmail accounts** list (every sender account seen, with per-account tracking default and per-account notification toggle), global tracking default, notification toggles (first open / click / reminders), disclosure footer toggle, quiet hours, a "Privacy" explainer.

### 6.5 Notifications and reminders
- Service worker polls `/v1/events?since=` and raises one notification per message per event type (batch bursts). Clicking opens the thread.
- Reminders fire from `chrome.alarms`; when due, re-check condition against the server and notify only if still unmet.
- Notifications name the account ("via you@work.com") whenever more than one account is known, and the click-through opens the thread under the correct Gmail account (`https://mail.google.com/mail/?authuser=<account>#all/<threadId>`).

### 6.6 Multi-account behavior
- The content script reports the active account to the service worker on load and on account switch; the service worker keeps a map of tab → account.
- All server reads from Gmail-facing surfaces (list marks, thread strip) are filtered by that account; the popup and options page can view all.
- Tracking default, notification toggles and quiet hours resolve in this order: per-account setting → global setting → built-in default.
- Edge cases to handle and test: "Send as" aliases (store the alias actually used as `senderAccount`), switching accounts mid-compose, the same recipient being another of the user's own accounts (counts as a real open), delegated/shared inboxes, and an account whose first-ever send happens before `/v1/accounts` knows it.

## 7. Quality bar

- Strict TS, no `any` without a comment. Shared schemas used on both sides.
- Tests: server (unit + integration via Hono `app.request`), open classifiers, link-rewriting function (pure and heavily tested against tricky HTML: nested tags, `<a>` with images, mailto, existing tracked links, quoted replies), service worker message bus, popup components (vitest + @testing-library/preact).
- Multi-account tests: messages from two accounts stay separated in list/thread surfaces, `account` filters on the API, alias handling, per-account self-open suppression, and settings precedence.
- A seed script (seeding at least two sender accounts) and a `scripts/simulate-open.ts` that hits the pixel with different UAs so I can demo without a second inbox.
- README: setup, env vars, how to load the unpacked extension, how to run the server, a manual test checklist for Gmail, known limitations (image blocking, MPP inflation, no-cache proxies), and privacy/legal notes (consent and disclosure obligations vary by jurisdiction; users are responsible for compliance).

## 8. Ground rules

- Be honest in the UI and docs: open tracking is probabilistic. Never claim certainty.
- No analytics, ads or third-party calls from the extension except the user's configured server.
- Don't scrape or read email content beyond what's needed (the outgoing body being sent, and thread/message IDs). Never send body text to the server; send only subject, recipients, and URLs.
- Commit after each stage with message `stage N: <name>`. Keep a running `docs/PROGRESS.md`.
- If a tool or package is unavailable, choose the closest substitute and log it in `docs/DECISIONS.md`. Never stop to ask.

---

## 9. EXECUTION PLAN — nine stages, in order

Each stage ends with a written artifact and a gate. Don't start the next stage until the gate passes. Use plan mode or a Plan subagent for the planning stages if available; otherwise do them inline.

### PLANNING (3 stages)

**P1 — Architecture & risk survey** → `docs/PLAN-1-architecture.md`
- Restate the product in your own words; confirm scope vs. out-of-scope.
- Verify the stack choices (InboxSDK compose/list/thread APIs, CRXJS + MV3 compatibility, `better-sqlite3` in Docker). Where reality differs from this prompt, document the adjustment.
- List the top 10 risks (Gmail DOM drift, proxy caching, MPP false opens, MV3 worker lifetime, CSP, InboxSDK app id, etc.) with a mitigation each.
- Gate: file exists; every risk has an owner stage (P/E/R number).

**P2 — Detailed design** → `docs/PLAN-2-design.md`
- Final repo tree, module boundaries, exported function signatures.
- Full zod schemas, SQL DDL, API contract table, message-bus type map (including the active-account reporting message and the tab → account map).
- Compose-send sequence diagram (text/Mermaid): presending → API → body rewrite → send → sent → PATCH.
- UI state machines for compose toggle, list marks, thread strip, popup.
- Gate: a reviewer could implement any module from this doc alone.

**P3 — Plan critique & task breakdown** → `docs/PLAN-3-tasks.md`
- Act as an adversarial reviewer of P1+P2. List at least 15 concrete flaws or gaps (races on send, double tracking, quoted-reply links, token storage, offline behavior, clock skew in `since` polling, etc.) and amend the design docs to fix each.
- Produce an ordered task list for E1–E3 with acceptance checks per task and estimated risk.
- Gate: every flaw is marked fixed-in-design or consciously deferred with a reason.

### EXECUTION (3 stages)

**E1 — Shared + server** 
- Scaffold monorepo, tooling, `verify` script, Dockerfile.
- Implement `/shared` schemas, the DB layer, all API routes, classifiers, link rewriting library, rate limiting, seed + simulate scripts.
- Gate: `npm run verify` passes for `/server` and `/shared`; simulated open/click via scripts shows up in the API; classifier fixtures pass.

**E2 — Extension core**
- Manifest, service worker (API client, auth, polling, alarms, notifications), typed message bus, storage.
- Gmail adapter: compose button, presending rewrite + pixel insertion, sent PATCH, failure fallback.
- Gate: extension builds; a mocked-adapter integration test proves send flow, double-track guard, failure-soft path; loads unpacked without console errors.

**E3 — UI surfaces**
- Sent-list marks, thread tracking strip, remind-me popover, popup dashboard, options page, notifications wiring, dark mode, a11y pass.
- Gate: component tests pass; every UI state (empty/loading/error/logged-out/offline) renders; manual-test checklist written in README.

### REVISION (3 stages)

**R1 — Correctness review**
- Re-read all code against PLAN-2. Fix deviations. Run the full test suite, add tests for any bug found. Race-test the send path (rapid double send, discard draft, offline). Verify self-open suppression and MPP handling end-to-end with the simulator.
- Output: `docs/REVIEW-1-correctness.md` listing findings and fixes. Gate: `verify` green.

**R2 — Security, privacy & Gmail-resilience review**
- Audit: open redirect, injection in rewritten HTML, token handling, CORS, rate limits, data retention and `DELETE /v1/me`, CSP, that no email body leaves the browser, logging hygiene.
- Break-test the Gmail adapter: simulate hooks failing, empty/odd compose bodies, plain-text mode, signature blocks, inline images, large bodies.
- Output: `docs/REVIEW-2-security.md`. Gate: all high/medium findings fixed; remaining low ones documented.

**R3 — Polish, docs & final verification**
- UX polish (copy, spacing, icons, tooltips), bundle size check, remove dead code, finalize README and all docs, ensure `.env.example`, and tag the version.
- Fresh-clone test: from a clean checkout, follow the README exactly and confirm the server runs, the extension builds and loads, and the simulate script produces visible opens in the popup.
- Output: `docs/REVIEW-3-final.md` plus a concise "what works / what's flaky / what's next" summary at the top of README. Gate: fresh-clone test passes.

---

When all nine stages are complete, print a final summary: what was built, how to run it, what I should manually test in Gmail first, and the three biggest remaining risks.