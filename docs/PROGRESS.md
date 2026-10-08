# Progress

| Stage | Status | Notes |
|---|---|---|
| P1 Architecture & risk survey | ✅ done | `PLAN-1-architecture.md`. InboxSDK 2.2.29 APIs verified from the package typings. |
| P2 Detailed design | ✅ done | `PLAN-2-design.md` |
| P3 Plan critique | ✅ done | 22 flaws; 18 fixed in design, 4 partially or consciously deferred |
| E1 Shared + server | ✅ done | shared 33 tests, server 84 tests (classifier fixtures, 2-account separation, self-view, dedupe, cursor). Seed + simulate verified against a live server; Docker image builds and serves. |
| E2 Extension core | ✅ done | 78 extension tests, including a full send-flow integration (fake compose → real SW handlers → real in-memory server): tracked send, double-track guard, fail-soft (down/timeout), Undo Send idempotency, aliases, 2-account separation. Built with CRXJS; loaded unpacked in headless Chrome for Testing 155: SW answers bus messages, no console errors. That check caught and fixed a router bug (options page in a tab was treated as a content script). |
| E3 UI surfaces | ✅ done | Sent-list marks (live), thread strip + remind-me popover (Shadow DOM, dark mode, ARIA), popup (all states: logged-out / loading / empty / error / offline / ready, account switcher, search, reminders), options page (connection, token connect, per-account tri-state settings, defaults, notifications, quiet hours, privacy). 111 extension tests. Popup/options rendered with seeded data in headless Chrome (light + dark), no console errors. README manual checklist written. |
| R1 Correctness review | ✅ done | 7 findings fixed (2 high: bus privilege, pixel rate-limit keying). Race tests added. Self-open suppression + MPP verified end-to-end with the simulator. See `REVIEW-1-correctness.md`. |
| R2 Security review | ✅ done | 1 high (InboxSDK telemetry blocked), 3 medium (URL validation in compose, X-Forwarded-For spoofing, chunked body limit), 2 low fixed; 5 low accepted and documented. Adapter break tests added. See `REVIEW-2-security.md`. |
| R3 Polish & final | ✅ done | Copy, layout, a11y and dead-code pass; bundle sizes recorded; fresh-clone test passed (install → verify → server → seed → simulate → extension in Chrome shows opens). Tagged v0.1.0. See `REVIEW-3-final.md`. |
