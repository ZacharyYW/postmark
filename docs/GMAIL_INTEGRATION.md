# Gmail integration

All Gmail-touching code lives in `extension/src/gmail/`. Only `inboxsdkAdapter.ts` imports InboxSDK. The rest depends on the `GmailAdapter` interface in `adapter.ts`, so the integration can be swapped for raw DOM observation and is tested with fakes. No Gmail CSS class names are hard-coded anywhere; every hook point comes from an InboxSDK API.

## Boot (`content.ts`)

1. `InboxSDK.load(2, VITE_INBOXSDK_APP_ID)`. If it throws (bad app id, Gmail change), we log once and stop. Gmail keeps working, and the popup and options page are unaffected.
2. `sdk.User.getEmailAddress()` gives the tab's account. The content script sends `ACTIVE_ACCOUNT {account, aliases}` to the service worker, which stores `tabId → {account, aliases}` in `chrome.storage.session`. The report is repeated on `visibilitychange`, in case the worker restarted or the extension was reloaded. Switching Gmail accounts loads a new page (`/mail/u/N`), so each content-script instance has exactly one account.
3. "Send as" aliases seen in compose windows (`getFromContactChoices()`) join the tab's scope. They are persisted per primary account so later sessions know them right away.

Privacy guard: `installGuard.ts` is the content script's first import. It blocks InboxSDK's built-in telemetry (`api.inboxsdk.com`, Pub/Sub) inside our isolated world. See REVIEW-2 S1.

MV3 requirement: the service worker imports `@inboxsdk/core/background.js`, which injects `pageWorld.js` (copied to the extension root at build time) into Gmail's main world through `chrome.scripting`. This is why the `scripting` permission exists.

## Hooks

| Surface | InboxSDK API | Our code | Depends on | Fails soft by |
|---|---|---|---|---|
| Compose toggle | `Compose.registerComposeViewHandler`, `composeView.addButton({type:'MODIFIER'})` with a live descriptor | `compose.ts` → `attachCompose` | compose toolbar | logging once; the email sends normally |
| Body rewrite | `presending` → `cancel()`, `getHTMLContent()` → rewrite → `setBodyHTML()`, `send()` (our re-send passes through) | `inboxsdkAdapter.ts` `onPresending` + `compose.ts` + `compose/rewriteBody.ts` | the Send button (InboxSDK's presending stream); works on every account type | 3 s cap; any error → original body re-sent + "Sent without tracking" toast |
| Sent binding | `sent` event → `getThreadID()` / `getMessageID()` | `compose.ts` (`BIND_SENT`, 4 attempts with backoff) | – | the message stays unbound: visible in the popup, no list mark |
| Sent-list marks | `Lists.registerThreadRowViewHandler`, `row.getThreadIDIfStableAsync()`, `row.addAttachmentIcon(liveValue)` | `listMarks.ts`, `marks.ts` | the attachment-icon column | no mark |
| Thread strip | `Conversations.registerMessageViewHandler`, `mv.getSender()`, `mv.getMessageIDAsync()`, `mv.getThreadView().getThreadIDAsync()`, `mv.getBodyElement()` (we insert before it) | `threadStrip.ts`, `ui/components/TrackingStrip.tsx` | message body element | no strip |
| Toasts | `ButterBar.showMessage / showError` | adapter `toast()` | – | silent |

### Scoping rules (multi-account)

* The service worker resolves the account from `sender.tab.id`. Content-script payloads can't choose an account.
* `GET_MARKS` and `GET_THREAD_TRACKING` query the server with `accounts=<primary,aliases…>`.
* The thread strip renders only when the message's sender is in the tab's scope **and** the tracked record's `senderAccount` is in scope. It checks this a second time, as defence in depth.
* The self-view beacon (`SELF_VIEW`) is sent only from the sender's own tab. The service worker checks again that the message's `senderAccount` is in the tab's scope.

### Compose details

* **Account**: `getFromContact().emailAddress`, read *at send time* so "Send as" changes mid-compose are honoured. It falls back to the tab account. If neither is known, the email is sent untracked.
* **Idempotency**: `clientRequestId = "<sender>:<composeId>"`. Undo Send, or a resend of the same compose, reuses the server message. A concurrent double-send shares one in-flight preparation.
* **Double tracking**: if the *fresh* part of the body already holds a Postmark pixel (`data-postmark`, `<server>/p/…`, or a Google image-proxy URL embedding it), the body is sent unchanged.
* **Replies / forwards**: everything inside `.gmail_quote_container`, `.gmail_quote`, `blockquote[type=cite]`, `.gmail_extra` (plus Outlook/Thunderbird quote markers) is left untouched. Signatures count as fresh content.
* **Plain-text mode** is sent untracked, with a toast.
* **Body text never leaves the browser.** Only the subject, recipients, URLs and the sender account are sent (enforced by a test that inspects every request body).

## Debugging

1. Open Gmail, then DevTools → Console, and filter on `[postmark]`. Each failing hook logs **once** with the error.
2. Service worker: `chrome://extensions` → Postmark → "Inspect views: service worker". `chrome.storage.session.get('tabAccounts')` shows the tab → account map. `chrome.storage.local.get(['lastPoll','pollCursor'])` shows polling health.
3. Check that the page-world script loaded: in the Gmail console, look for InboxSDK's own logs. A missing `pageWorld.js` produces an InboxSDK error mentioning `inboxsdk__injectPageWorld`.
4. If compose tracking silently doesn't happen, check the popup's sign-in state, the server URL host permission (Options → Save server), and the `prepare failed` log line.
5. After a Gmail UI change breaks something: upgrade `@inboxsdk/core` first. Streak ships fixes quickly, and our code depends only on its public API.
