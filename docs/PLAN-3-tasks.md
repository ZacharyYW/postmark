# PLAN-3 — Adversarial critique & task breakdown

## A. Flaws found in P1 + P2, and their resolution

| # | Flaw / gap | Resolution | Status |
|---|---|---|---|
| F1 | **Double send / Undo Send race.** Gmail's "Undo send" returns the message to a draft whose DOM has no pixel (we only modified the XHR). The resend calls the modifier again and would create a second message. A rapid double-click can also fire the modifier twice. | `clientRequestId = account + ':' + composeId`. The server returns the existing unbound message for the same `(user, clientRequestId)` and registers any new URLs. The compose controller also memoises the in-flight promise per compose. | fixed-in-design (PLAN-2 §2, §4) |
| F2 | **Draft re-opened / resent / forwarded with an old pixel** → double tracking. | `hasPostmarkPixel(html, origin)` checks the fresh part only. If a pixel is present in the fresh part, skip tracking. Pixels and tracked links inside the quoted part stay untouched (they belong to the earlier message). | fixed-in-design (§8) |
| F3 | **Quoted-reply links** would be re-tracked and attributed to the new message. | `splitQuoted()` covers `.gmail_quote`, `.gmail_quote_container`, `blockquote[type=cite]` and `.gmail_extra`. Only the fresh part is collected and rewritten. | fixed-in-design (§8) |
| F4 | **Token takeover via re-register.** Dev-grade register for an existing email would hand anyone a token. | 409 for existing emails unless `DEV_ALLOW_TOKEN_ROTATION=true` (off by default). Production plan: OAuth (D-006). | fixed-in-design |
| F5 | **Token exposure to Gmail's page.** If the token reached the content script, page-world code could read it. | The token only lives in the SW (`storage.local`). Content scripts never receive it. `storage.local` is not accessible from the page world. `storage.session` access level is left at the default (trusted contexts only). | fixed-in-design |
| F6 | **Clock skew in `since` polling** → missed or duplicated events. | Server-issued cursor (event id) plus a settle window (events younger than 20 s are held back so self-view reclassification can land first). Cursor contiguity: stop at the first unsettled id. | fixed-in-design (§4, §10) |
| F7 | **Offline / server down at send** blocks sending. | 3 s `AbortController` timeout in the content script (`Promise.race`) and in the SW fetch. The modifier returns the original body and shows a toast. Never throws past the modifier. | fixed-in-design |
| F8 | **Switching "From" mid-compose** leaves a stale account and stale default. | Read `getFromContact()` *at send time* (inside the modifier). Re-resolve the toggle default on `fromContactChanged` unless the user has touched the toggle. | fixed-in-design (§9) |
| F9 | **SW killed between PREPARE and BIND.** The PATCH never happens, so the message has no thread id and list marks can't match. | `BIND_SENT` is retried 3× with backoff. Unbound messages still appear in the popup, which can match by subject only for display. The thread strip falls back to matching via `gmailMessageId` once bound later. Documented. | fixed-in-design / partially deferred (no background re-bind job) |
| F10 | **Link scanners** (Defender/Safe Links, Proofpoint) click every link on delivery → false clicks. | Bot UA signatures, plus clicks within 10 s of send classified as `bot`. Documented as a heuristic. | fixed-in-design (§5) |
| F11 | **Plain-text compose mode**: an `<img>` pixel can't be inserted. | `isPlainText` → send untracked with the toast "Plain-text mode: sent without tracking". | fixed-in-design |
| F12 | **`no_reply` reminder has no data source** (the server can't see replies). | The content script reports replies it can observe (thread view: a message from someone other than the sender after the tracked one; list row: message count > 1 with a non-sender contact) through `REPORT_REPLY` → `PATCH repliedAt`. UI copy says "no reply *detected*". | fixed-in-design (honest limitation) |
| F13 | **Notification storms** when MPP or a forwarded mail triggers many opens. | Notify only on `isFirst` opens. Clicks are batched per message per poll ("3 link clicks"). Max 5 notifications per poll, then a summary notification. | fixed-in-design |
| F14 | **Account spoofing from a content script.** A payload `account` field could request another account's data. | The SW resolves the account from `sender.tab.id` → tab map, never from the payload. The server filters by `account`. | fixed-in-design (§6) |
| F15 | **First-ever send from an account `/v1/accounts` doesn't know.** | The settings resolver works without account settings (falls back to global). `/v1/accounts` is derived from messages ∪ settings keys, so the account appears after its first send. The options page also lists accounts seen in `tabAccounts`. | fixed-in-design |
| F16 | **Delegated / shared inboxes.** `sdk.User.getEmailAddress()` is the delegate's own address, but mail is sent "on behalf of" the owner. | `senderAccount` comes from `getFromContact()` (the address actually used). The tab account comes from `User.getEmailAddress()`. In a delegated inbox the From differs from the tab account, so list/thread marks for those messages show only in the tab whose account matches the From. Documented as a limitation. | consciously deferred (documented) |
| F17 | **ID enumeration / open redirect** on `/l/:id`. | 21-char nanoid. Redirects only to a stored URL, http(s) only. Unknown id → 404 with no reflection. | fixed-in-design |
| F18 | **Unbounded event growth** (bots hammering a pixel). | Per-IP-hash token bucket, plus 30 s dedupe. Rate-limited pixel requests still return the GIF but are not recorded. A retention TTL is deferred (documented as future work, along with `RETENTION_DAYS`). | partially deferred |
| F19 | **Gmail caches the proxied pixel**, so repeat opens are lost. | `no-store` headers. Documented as a known limitation (Gmail may still cache per recipient). | fixed / documented |
| F20 | **Header-injection / HTML-injection via subject or URLs** in UI surfaces. | All UI renders via Preact (escaped). Shadow DOM strips use `textContent`. Links in the popup use `gmailThreadUrl()` with an encoded thread id. | fixed-in-design |
| F21 | **InboxSDK request modifier requires a draft id** (throws before the draft is saved). | `safeRegisterModifier()` retries on `draftSaved`, `bodyChanged` (throttled) and `presending`. If still unregistered at send, that message goes untracked and the failure is logged once. | fixed-in-design |
| F22 | **Rate limiting the auth API with an in-memory bucket** loses state on restart and doesn't scale across instances. | Acceptable for single-instance v1. Documented. | consciously deferred |

## B. Ordered task list

Risk ratings: L / M / H.

### E1 — Shared + server

| # | Task | Acceptance check | Risk |
|---|---|---|---|
| 1 | Monorepo scaffold: workspaces, tsconfig, ESLint flat config, Prettier, root scripts (`verify`, `typecheck`, `lint`, `test`, `build`) | `npm install` succeeds; `npm run verify` runs | L |
| 2 | `/shared`: constants, schemas, settings resolver, account and url helpers, bus map | Unit tests for `resolveSettings`, `normalizeAccount`, `isTrackableHref` | L |
| 3 | DB: DDL, `openDb`, meta salt/secret, repo functions | In-memory DB tests: insert/list, cascade delete | M |
| 4 | Classifiers + CIDR + fixtures | Fixture table per class (≥25 UAs) passes | M |
| 5 | Recording: dedupe, firsts, self-view reclassify | Unit tests for 30 s dedupe, retro self-view, `isFirst` promotion | H |
| 6 | Routes: auth, messages, accounts, events (cursor + settle), reminders, me, public | `app.request` integration tests for every route + 2-account separation + alias | M |
| 7 | Middleware: auth, rate limit, CORS, secure headers | Tests for 401, 429, CORS headers | M |
| 8 | Seed + simulate scripts, Dockerfile, compose file | Run the scripts against a local server; events visible via the API | M |

### E2 — Extension core

| # | Task | Acceptance check | Risk |
|---|---|---|---|
| 9 | Vite + CRXJS + manifest; copy `pageWorld.js` | `npm run build -w extension` produces dist with a manifest | H |
| 10 | Bus client/router (typed) | Unit tests: routing, error envelope, unknown type | L |
| 11 | SW: api client (timeout), auth, settings, tabAccounts, poll, notify, reminders | Unit tests with a mocked `chrome` + fetch | M |
| 12 | `rewriteBody` | ≥20 tricky-HTML tests | M |
| 13 | Gmail adapter interface + InboxSDK implementation + compose controller | Mocked-adapter integration test: tracked send, untracked when off, timeout → original body + toast, double-track guard, idempotency key | H |

### E3 — UI surfaces

| # | Task | Acceptance check | Risk |
|---|---|---|---|
| 14 | List marks controller + mark rendering | Tests: account filter, live update | M |
| 15 | Thread strip + remind-me popover (Shadow DOM, Preact) | Component tests for states; `SELF_VIEW` sent once | M |
| 16 | Popup: Recent, Reminders, account switcher, search, all states | @testing-library tests for loggedOut/loading/empty/error/offline/ready | M |
| 17 | Options page | Tests: register flow, accounts list toggles | L |
| 18 | Dark mode, a11y, README manual checklist | Lint passes; ARIA labels present (asserted in tests) | L |
