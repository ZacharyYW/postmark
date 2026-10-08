# REVIEW-2 — Security, privacy & Gmail resilience

Method: manual audit of every server route, middleware and extension entry point; a grep of the built bundles; tests for every fix; break-tests of the Gmail adapter with a mocked InboxSDK whose APIs throw.

## Findings

| # | Sev. | Area | Finding | Resolution | Test |
|---|---|---|---|---|---|
| S1 | **High** | Privacy | **InboxSDK phones home.** The npm build sends error reports and usage events (hashed user email, extension id, origin) to `api.inboxsdk.com` and a Google Pub/Sub topic. `eventTracking:false` turns off only part of it. This breaks "no third-party calls" (spec §8). | `telemetryGuard.ts`, imported first in the content script, wraps `XMLHttpRequest`/`fetch` **in our isolated world only**, so other extensions are untouched. Requests to those hosts fail locally with status 490, InboxSDK's own "stop contacting this server" signal, and no packet is sent. Also load with `eventTracking:false, globalErrorLogging:false`. | `telemetryGuard.test.ts` |
| S2 | **Medium** | Injection | The compose rewrite trusted `pixelUrl`/`trackedUrl` from the server. A misconfigured or hostile server could inject `javascript:` or third-party URLs into outgoing mail. | Every URL must be on the configured tracking origin, under `/p/` or `/l/`; otherwise the message is sent untracked with a toast. Attributes are set through the DOM, so they are escaped (existing test). | `composeFlow.test.ts` "hostile server responses", `rewriteBody.test.ts` "escapes hostile tracked URLs" |
| S3 | **Medium** | Rate limiting | With `TRUST_PROXY`, the *first* `X-Forwarded-For` entry was used. It is client-controlled, so rate limits and dedupe could be dodged. | The right-most entry (appended by our proxy) is used. | `api.test.ts` "client IP behind a proxy" |
| S4 | **Medium** | Availability | `jsonBody` checked only `Content-Length`; chunked bodies bypassed the size cap. | `hono/body-limit` (256 KB) on `/v1/*`. | `api.test.ts` "rejects oversized bodies" |
| S5 | Low | Abuse | Unbounded per-account settings keys could bloat a user's row. | Cap of 100 accounts with custom settings. | `api.test.ts` |
| S6 | Low | Retention | No retention: self-view beacons and events grew forever (F18). | Housekeeping every 6 h: self-views older than 1 day are deleted. Optional `RETENTION_DAYS` deletes old messages, cascading to links, events and reminders. | `api.test.ts` "purge…" |
| S7 | High (fixed in R1) | Messaging | Options page treated as a content script (C1). | URL-based privilege. | `bus.test.ts` |
| S8 | High (fixed in R1) | Rate limiting | Per-IP pixel limit starved Gmail-proxy traffic (C2). | Split per-IP / per-resource buckets. | `api.test.ts` |

## Audit checklist (no change needed)

* **Open redirect:** `/l/:id` redirects only to the `links.original_url` row for a 21-char nanoid. URLs are checked as http(s) when registered (zod) *and* again before redirecting. Unknown ids → generic 404 that doesn't reflect input. `?url=` style parameters are ignored. *Residual:* any registered user can mint redirects to URLs of their choice. That's inherent to link tracking; mitigated by per-user rate limits, and the production auth plan narrows who can register.
* **IDs:** message, pixel, link and reminder ids are 21-char nanoids (~126 bits), so they can't be enumerated. All user-scoped SQL takes `user_id`; cross-user access is tested and returns 404.
* **SQL injection:** every query is a prepared statement. The only interpolation is from compile-time constants. LIKE wildcards are escaped.
* **Tokens:** 32 random bytes; the server stores only their sha256. They live in the extension's `chrome.storage.local`, are sent only by the service worker as a Bearer header, and are never sent to content scripts (`GET_AUTH_STATE` returns email/server only) or logged. Plain `http://` server URLs are refused except for localhost. *Residual (low):* our own content script could technically read `storage.local`. Gmail's page can't (isolated world, and the page world is never given the token).
* **Message bus:** sender id must equal ours. Privilege is decided by sender URL. Content scripts are limited to a whitelist of 10 message types. There's no `externally_connectable`, so web pages can't message the worker. The tab → account scope comes from `sender.tab.id`, never from the payload.
* **UI injection:** Preact escapes everything. The Gmail strip renders in a Shadow root. Row tooltips go through InboxSDK's `data-tooltip` (an attribute). Toasts and notifications are plain text. No `innerHTML` with server data anywhere (`grep innerHTML extension/src` → only `rewriteBody` serialising the body it parsed).
* **CSP:** `script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'` for extension pages. The built bundles contain no `eval`. The two `new Function` occurrences are inside InboxSDK's content script (a polyfill feature-detect), which runs in the isolated world. No remote code is loaded (the npm InboxSDK build strips its remote loader).
* **CORS:** `/v1/*` allows only `https://mail.google.com` and `chrome-extension://<EXTENSION_IDS>`. *Residual:* empty `EXTENSION_IDS` means any extension origin (dev only; logged at startup; documented). Public routes are open by design.
* **Security headers:** Hono `secureHeaders` (HSTS, nosniff, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `CSP default-src 'none'`); CORP `cross-origin` so mail clients can embed the pixel.
* **Body never leaves the browser:** `composeFlow.test.ts` captures every request body the service worker sends and asserts that the email text is absent. The server schema has no body field.
* **Logging hygiene:** the server logs startup info, retention counts, and unhandled errors as `method + route pattern + error message` (no bodies, tokens, IPs or UAs). The extension logs `[postmark]` warnings once per failure key, with no payloads.
* **`DELETE /v1/me`:** cascades to messages, links, events, self-views and reminders. Tested: afterwards the token is 401, the pixel records nothing, and links 404. The extension also clears its local caches.
* **Stored data minimisation:** an `events` row holds a salted IP hash (per-install salt) and a coarse class. A test asserts that no raw IP or UA appears anywhere in the table.

## Gmail adapter break tests (`adapterResilience.test.ts`, `rewriteBody.test.ts`)

* Every `register*Handler` throwing, `User.getEmailAddress` throwing, ButterBar throwing → logged once, nothing propagates.
* Compose getters throwing → `null`/`[]`. Toolbar `addButton` throwing → the toggle becomes a no-op and sending still works.
* `registerRequestModifier` throwing before a draft id exists → retried on `draftSaved`, registered once.
* No draft id at send → `presending` fallback: cancel, rewrite in place, re-send exactly once.
* Row/message APIs rejecting or throwing → `null`/`[]`/`false`. `mountAboveBody` returns `false` and no strip is shown.
* Odd bodies: empty, whitespace-only, quote-only, full HTML documents with `<head>`/comments, uppercase schemes, newline-padded and entity-encoded hrefs, malformed nested anchors, RTL and emoji, `<script>` (not executed), inline `cid:` images, signature blocks, 2,000-link bodies. Plain-text mode → untracked with a toast.

## Remaining low-severity items (accepted, documented)

1. Dev-grade auth: open registration, and 409 reveals whether an email is registered. Production plan: OAuth (D-006).
2. Any-extension CORS when `EXTENSION_IDS` is empty (dev default).
3. In-memory rate limits (single instance only; F22).
4. `storage.local` is readable by our own content script.
5. Running in Docker without a reverse proxy makes every request share the bridge IP, so dedupe and unique counts degrade. README: run behind a proxy with `TRUST_PROXY=true`.
