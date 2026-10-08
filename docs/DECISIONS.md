# Decisions log

Each entry: id, decision, why, alternatives considered.

| ID | Decision | Why |
|---|---|---|
| D-001 | Add the `scripting` permission and ship `pageWorld.js` at the extension root. | Required by `@inboxsdk/core` MV3 (`background.js` injects `pageWorld.js` into the MAIN world). The spec lists only storage/alarms/notifications. |
| D-002 | Rewrite the outgoing body with `composeView.registerRequestModifier` (async) rather than mutating the DOM in `presending`. | `presending` is synchronous in InboxSDK 2.2.29, so it can't await the 3 s server call. The request modifier is awaited, and InboxSDK falls back to the original body if the promise rejects (fail-soft). Cancel-then-resend inside `presending` is kept as a documented fallback only. |
| D-003 | Build with `@crxjs/vite-plugin` 2.7.1 + Vite 6. | 3.0.0 is too fresh. Fallback to plain Vite multi-entry if CRXJS fails. |
| D-004 | Pin TypeScript 5.9, zod 3.25, Preact 10, Vitest 3, ESLint 9. | Newest majors (TS 7, zod 4, Preact 11, Vitest 5, ESLint 10) are too new for the ecosystem plugins (typescript-eslint, testing-library). |
| D-005 | Self-open suppression via a **self-view beacon** plus a ±20 s window, the 10 s post-send rule, and an `?s=` HMAC token for direct fetches. | GoogleImageProxy strips the sender's cookies/headers, so a header-based approach can't work for Gmail→Gmail. |
| D-006 | Dev-grade auth: `POST /v1/auth/register {email}` → random 32-byte token, stored as a sha256 hash. | Spec. Production plan: `chrome.identity.getAuthToken` → Google ID token verified server-side. |
| D-007 | Quiet hours are evaluated in the service worker. Suppressed notifications are summarised as one notification when quiet hours end. | The server doesn't know the user's timezone. |
| D-008 | `/v1/events` polling uses a server-issued opaque cursor (monotonic event id), not timestamps. `since=<iso>` is still accepted for compatibility. | Avoids clock skew between client and server. |
| D-009 | Gmail account switch reloads the page (`/u/N`), so each content-script instance reports exactly one account. The SW maps `tabId → account` in `chrome.storage.session`. | Matches Gmail behaviour; survives SW restarts. |
| D-010 | Docker base `node:20-bookworm-slim`. | `better-sqlite3` prebuilds need glibc. |
