# PLAN-1 — Architecture & risk survey

## 1. The product, restated

Postmark is a Chrome MV3 extension plus a small self-hostable server that gives a Gmail
user *probabilistic* read receipts for mail they send:

* At send time the extension asks the server to mint a message record, then rewrites the
  outgoing HTML: every eligible `<a href>` in the newly-typed portion is pointed at a
  server redirect (`/l/:linkId`) and a 1×1 image (`/p/:pixelId.gif`) is appended.
* When a recipient's client (or, very often, a proxy acting for it: Gmail's
  GoogleImageProxy, Apple Mail Privacy Protection, corporate scanners) fetches the pixel or
  follows a link, the server records an event, classifies the requester coarsely, and
  dedupes.
* The extension's service worker polls the server, raises desktop notifications, and pushes
  fresh data into Gmail UI surfaces: Sent-list ✓/✓✓ marks, a per-message "Tracking" strip in
  thread view, a "Remind me" follow-up popover, a popup dashboard, and an options page.
* Everything is **multi-account aware**: one Postmark user, many Gmail accounts in one Chrome
  profile; each tracked message stores the `sender_account` that sent it; Gmail-facing UI only
  ever shows data for the account active in that tab.

Postmark never sends email bodies to the server — only subject, recipient addresses and the
URLs being rewritten.

### Scope check

| In scope (ships)                                       | Out of scope (README "future work") |
|--------------------------------------------------------|-------------------------------------|
| Pixel open tracking, first/repeat opens                | Mail merge                          |
| Link click tracking via redirect                       | Scheduled send, snooze              |
| Compose toggle, Sent-list marks, thread strip          | Templates                           |
| Popup dashboard, options page                          | Outlook / Yahoo                     |
| Desktop notifications (first open, click, reminders)  | Team accounts, billing              |
| Follow-up reminders (`chrome.alarms`)                  | Firefox / Safari builds             |
| Per-email + global opt-out, optional disclosure footer |                                     |
| Backend: auth, SQLite, rate limiting, tests            |                                     |
| Multi-account support                                  |                                     |

## 2. Stack verification (done against real packages, 2026-10-07)

| Item | Finding | Adjustment |
|---|---|---|
| `@inboxsdk/core` 2.2.29 | Ships a fully bundled build (no remote code in the npm build — the source explicitly strips the remote loader). MV3 requires `import '@inboxsdk/core/background.js'` in the SW; that script calls `chrome.scripting.executeScript({world:'MAIN', files:['pageWorld.js']})`. | Add `scripting` permission; copy `pageWorld.js` to the extension root. (D-001) |
| Compose API | `registerComposeViewHandler`, `composeView.addButton({iconUrl, tooltip, type:'MODIFIER', onClick})`, events `presending({cancel})`, `sending`, `sent({getMessageID(), getThreadID()})` (async getters), `getFromContact()`, `getFromContactChoices()`, `fromContactChanged`, `getHTMLContent()`, `setBodyHTML()`, `getBodyElement()`, `isReply()`, `isForward()`. **`presending` is synchronous** — it cannot await a network call. | Use `composeView.registerRequestModifier(async ({body,isPlainText}) => ({body}))`: InboxSDK intercepts Gmail's send XHR and awaits our promise; on rejection it falls back to the original body (fail-soft is built in). `presending` is used only to snapshot state. (D-002) |
| List API | `Lists.registerThreadRowViewHandler(row => …)`, `row.addLabel(descriptor or Kefir stream)`, `row.addImage`, `row.getThreadIDIfStableAsync()`, `row.getContacts()`. Label descriptors may be a stream → live updates without re-render. | Use `addLabel` with a Kefir-compatible stream (an object with `onValue`); fall back to static re-add. |
| Thread API | `Conversations.registerMessageViewHandler(mv => …)`, `mv.getMessageIDAsync()`, `mv.getSender()`, `mv.getBodyElement()`, `mv.getElement()`, `mv.getThreadView().getThreadIDAsync()`. | Strip is injected before the body element inside a Shadow root. |
| User API | `sdk.User.getEmailAddress()` returns the account of the tab. | Account reporting on load. Gmail reloads the page on account switch (`/u/N`), so "on account switch" = new content-script instance. |
| `@crxjs/vite-plugin` | 2.7.1 stable supports Vite 3–8 and MV3. 3.0.0 is two weeks old. | Use 2.7.1 with Vite 6. If it can't handle InboxSDK, fall back to plain Vite multi-entry (D-003). |
| `better-sqlite3` 12.x | Prebuilt binaries for Node 20/22 on linux-x64/arm64 glibc; `node:20-bookworm-slim` works. Alpine needs a toolchain. | Debian-slim base image with build deps in a builder stage as a safety net. |
| Hono 4 + `@hono/node-server` 1.x | `app.request()` for integration tests; CORS + secure-headers middleware built in. | — |
| zod | v4 is current but v3.25 is the mature API; both sides import from `/shared`. | Pin zod 3.25. |
| TypeScript | 7.x (native port) is new; typescript-eslint targets 5.x. | Pin TS 5.9. |

## 3. Component architecture

```
┌──────────────────────── Gmail tab (mail.google.com/mail/u/N) ────────────────────────┐
│ content script                                                                        │
│  gmail/adapter.ts (interface)  ←  gmail/inboxsdkAdapter.ts (only file importing SDK)  │
│  gmail/compose.ts  gmail/listMarks.ts  gmail/threadStrip.ts  gmail/shadow.ts          │
│  compose/rewriteBody.ts  (pure HTML transform, DOMParser)                             │
│            │ typed bus (chrome.runtime.sendMessage / tabs.sendMessage)                │
└────────────┼──────────────────────────────────────────────────────────────────────────┘
             ▼
┌──────────────────────── Service worker ─────────────────────────┐
│ bus/router.ts → handlers                                         │
│ api.ts (fetch + 3 s timeout + Bearer)  auth.ts  settings.ts      │
│ tabAccounts.ts (storage.session)  poll.ts (alarms)               │
│ notify.ts (batched)  reminders.ts (alarms)                       │
│ + @inboxsdk/core/background.js                                   │
└────────────┬────────────────────────────────────────────────────┘
             │ HTTPS JSON (Bearer)                ▲ popup / options (Preact) talk to SW via bus
             ▼
┌──────────────────────── Server (Hono, :8787) ───────────────────┐
│ routes/*  middleware/{auth,rateLimit,cors,securityHeaders}       │
│ tracking/{classify,dedupe,selfOpen}  db (better-sqlite3, WAL)    │
└─────────────────────────────────────────────────────────────────┘
      ▲ GET /p/:pixelId.gif   ▲ GET /l/:linkId
  Recipient client / GoogleImageProxy / Apple MPP / scanners
```

## 4. Top risks

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | **Gmail DOM drift** breaks hooks | UI silently disappears | All Gmail access goes through InboxSDK behind `gmail/adapter.ts`. Each hook is wrapped in `safeAttach()` that logs once and continues. `GMAIL_INTEGRATION.md` has a debug guide. | E2, R2 |
| R2 | **Sender self-opens via GoogleImageProxy.** Proxy strips cookies/headers, so the sender's own view looks like a recipient open. | Inflated / false "Opened" | 10 s post-send grace, plus the **self-view beacon**: the thread strip reports "account A is viewing message M". Server reclassifies `gmail_proxy` opens within ±20 s as `sender`, retroactively. `?s=` token for direct fetches. | E1, E3, R1 |
| R3 | **Image proxy caching** hides repeat opens | Under-count | `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `Expires: 0`. Document that Gmail may still cache. | E1 |
| R4 | **Apple MPP prefetch** marks everything opened | False positives | Classify Apple proxy (UA + configurable CIDR list + "within 60 s of send from non-Gmail proxy" heuristic) as `apple_mpp`. Shown as "possibly auto-loaded", excluded from unique opens and notifications. | E1 |
| R5 | **Security scanners** pre-click links | False clicks | Scanner UA signatures → `bot`, excluded. Clicks within 5 s of send are treated as `bot`. | E1 |
| R6 | **MV3 SW lifetime** kills state mid-flow | Lost tab→account map, lost cursor | All state in `chrome.storage.session/local`. Alarms re-registered on `onStartup`/`onInstalled`. Presend call handled as one short request/response. | E2 |
| R7 | **Send latency / failure** blocks mail | User-visible harm | Hard 3 s timeout. InboxSDK request modifier falls back to the original body on reject. Toast "Sent without tracking". | E2 |
| R8 | **InboxSDK app id** placeholder may refuse to load or log warnings | No Gmail UI | `VITE_INBOXSDK_APP_ID` env with a clearly-marked placeholder. README explains registering a free app id. Adapter load failure is caught and logged; the popup still works. | E2, R3 |
| R9 | **CSP / remote code**: MV3 forbids remote code | Web-store rejection, runtime errors | npm InboxSDK build only. Strict `content_security_policy.extension_pages`. No `eval`. Preact without runtime compilation. | E2, R2 |
| R10 | **Multi-account leakage**: wrong account's data in a tab | Privacy bug | Every Gmail-surface request is filtered server-side by `account`. SW resolves the account from `sender.tab.id` (not from the payload). Tests with two accounts. | E1, E3, R1 |
| R11 | **"Send as" alias detection** | Wrong `senderAccount` | Use `composeView.getFromContact().emailAddress` (the alias actually used), lower-cased. If missing, fall back to `sdk.User.getEmailAddress()`. If both are missing, send untracked. | E2 |
| R12 | **Open redirect** via `/l/` | Phishing abuse | Redirect only to `links.original_url` for a registered 21-char nanoid. http/https only, checked at registration and at redirect. | E1, R2 |

## 5. Data and trust boundaries

* The browser has the outgoing body. The server only ever receives `{senderAccount, subject, recipients[], links[]}`.
* Bearer token lives in `chrome.storage.local`. It never reaches content scripts or Gmail's page world.
* The server stores `ip_hash = sha256(salt‖ip)` truncated, plus a coarse `ua_class`. No raw IP or UA.
