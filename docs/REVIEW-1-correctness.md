# REVIEW-1 — Correctness

Scope: re-read all code against PLAN-2, race-test the send path, and verify self-open suppression and MPP handling end-to-end with the simulator.

## Findings and fixes

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| C1 | High | **Bus privilege bug** (found by loading the build in Chrome for Testing during E2). The options page opens in a tab, so `sender.tab` was set and the router treated it as a content script, blocking REGISTER / DELETE_ME / LIST_* from options. | Privilege is decided by sender URL (`chrome-extension://<our id>/`) (D-019). | `bus.test.ts`: "extension pages opened in a tab…", "content script cannot spoof…" |
| C2 | High | **Pixel rate limit keyed only by IP.** GoogleImageProxy fetches every Gmail recipient's images from a few shared Google IPs, so one busy sender would exhaust the 60-request bucket and real opens would silently go unrecorded. | Two buckets: generous per-IP (1200 burst, 20/s) plus tight per-(IP, pixel/link) (20 burst, 1 per 5 s). Over-limit requests are still served. | `api.test.ts`: "per-resource limit does not starve other pixels…" |
| C3 | Medium | **Quiet-hours queue ignored per-account quiet hours** when flushing (it used global only), so held notifications could be released during an account's quiet hours or held too long. | Queue entries carry the account; each flush releases only entries whose resolved quiet hours are over. | `service.test.ts`: "quiet hours per account" |
| C4 | Medium | **Sent-list re-queried untracked threads on every re-render** (each navigation to Sent), which is wasteful and could hit the per-user API limit. | Negative cache (60 s TTL). A pushed `DATA_UPDATED` bypasses it, so a just-bound send shows immediately. | `marks.test.ts`: "list marks negative cache" |
| C5 | Low | Popup said "Opened 1 min ago" for a message whose only event was an Apple-MPP prefetch, overstating certainty. | `lastEventLabel` says "Possibly auto-loaded". | `marks.test.ts`: "lastEventLabel honesty" |
| C6 | Low | Popup rows truncated the recipient and subject because of the account chip (seen in a headless-Chrome screenshot). | Chip moved to its own "via …" line. | `popup.test.tsx` |
| C7 | Low | The GIF was 42 bytes, not the 43 the spec asks for. | Canonical 43-byte GIF89a. | `api.test.ts` |

## Deviations from PLAN-2, all accepted and documented

* `GET /v1/messages` gained `accounts=<csv>` (tab scope = primary + aliases, D-018).
* `GET /v1/messages/:id/pixel` and `PATCH /v1/reminders/:id` were added (D-014).
* `ACTIVE_ACCOUNT` carries `aliases`, and `CONNECT_TOKEN` was added to the bus.
* The Gmail adapter exposes `getLaterSenders()` instead of `getThreadSenders()`, to detect replies relative to the tracked message.

## Send-path race tests (all in `extension/test/composeFlow.test.ts`)

* Rapid double send while the first preparation is in flight → one server message, identical bodies.
* Undo Send, then resend of the same compose → same pixel, one message (`clientRequestId`).
* Discard draft → no server call.
* Offline / server down → original body + toast. The server coming back → the next compose tracks.
* Slow server (> timeout) → original body within the cap.
* Already-tracked body (draft resend) → unchanged; reply quoting a tracked email → tracked anew.

## End-to-end with the simulator (live server, 2026-10-07)

```
npm run seed
npm run simulate -- --account alex.work@example.com --self-view --profiles gmail_proxy
  → status=sent opens=0                        # sender's own view suppressed
(35 s later, no beacon)
npm run simulate -- --account alex.work@example.com --profiles gmail_proxy
  → status=opened opens=1                      # outside the ±20 s window: a real open
npm run simulate -- --account alex.personal@gmail.com --profiles apple_mpp
  → status=auto_loaded opens=0 possiblyAutoLoaded=1
```

Per-account suppression (an open by account B of mail sent from A counts) is covered by `server/test/api.test.ts` and `extension/test/service.test.ts`.

## Result

`npm run verify` passes: shared 37, server 85, extension 115 tests, plus both builds.
