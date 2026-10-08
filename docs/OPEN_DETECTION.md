# Open & click detection heuristics

> **Open tracking is probabilistic.** A pixel fetch means *some software* loaded the image: a person, a mail client, an image proxy, a privacy prefetcher, or a security scanner. Postmark classifies each fetch coarsely and shows its best guess. It never claims certainty.

Code: `server/src/tracking/classify.ts` (pure classifiers) and `server/src/tracking/record.ts` (context, dedupe, firsts, self-view). Fixtures: `server/test/fixtures/user-agents.ts`.

## Classes (`ua_class`)

| Class | Meaning | Counted as an open? | Notifies? | UI |
|---|---|---|---|---|
| `gmail_proxy` | Fetched by Gmail's GoogleImageProxy on behalf of a Gmail reader | ✅ | ✅ (first open) | "Opened" |
| `other` | A mail client or browser fetched it directly | ✅ | ✅ (first open) | "Opened" |
| `apple_mpp` | Likely Apple Mail Privacy Protection prefetch | ❌ (shown separately as `autoLoaded`) | ❌ | "Opened (possibly auto-loaded)" |
| `sender` | The sender's own view | ❌ | ❌ | hidden (visible in the raw events list) |
| `bot` | Security scanner, link expander, CLI tool, crawler | ❌ | ❌ | hidden |

## Open rules, in evaluation order

1. **Sender signature.** `?s=<hmac>` on the pixel URL, where `hmac = HMAC(install secret, pixelId|senderAccount)` truncated to 16 chars. A valid signature → `sender`. Used for direct (non-proxied) fetches the extension makes for the sender's own view. It cannot help with Gmail's proxy (see rule 6).
2. **Post-send grace.** Any fetch within **10 s** of `sent_at` → `sender`. Gmail renders the just-sent message in the sender's own tab, and that fetch goes through the proxy.
3. **Gmail proxy.** UA contains `GoogleImageProxy` or `via ggpht.com` → `gmail_proxy`.
4. **Bots / scanners.** UA empty, or matching `BOT_RE`: curl, wget, python-requests/urllib, Go-http-client, Java, okhttp, HeadlessChrome, Barracuda, Proofpoint, Mimecast, Symantec/MessageLabs, Forcepoint, Trend Micro, Sophos, IronPort/Cisco, Zscaler, SafeLinks, Bing/Facebook/Slack/Skype previewers, VirusTotal, urlscan, generic `bot`/`crawler`/`spider`/`scanner` → `bot`. "Microsoft Office/16.0" (Outlook desktop) is deliberately *not* matched.
5. **Apple MPP.** Any of the following → `apple_mpp`:
   * the IP is inside `APPLE_MPP_CIDRS` (default `17.0.0.0/8`; extend with the egress ranges Apple publishes);
   * the UA is exactly `Mozilla/5.0`, as observed from MPP proxies;
   * the UA is Apple-Mail-shaped (`AppleWebKit` with no `Safari`/`Chrome`/`Firefox`/`Edg` token) **and** the fetch is within **120 s** of send. MPP prefetches on delivery, while a human opening seconds after delivery is rarer.

   Apple-Mail-shaped fetches later than 120 s are classified `other`. They may still be MPP re-fetches; that is the main source of MPP inflation.
6. **Self-view beacon (Gmail sender suppression).** When the extension's thread strip renders a tracked message in a tab whose active account equals the message's `sender_account`, it posts `POST /v1/messages/:id/self-view {account}`. On the server:
   * new `gmail_proxy` opens within **±20 s** of a self-view by the *sending* account become `sender`;
   * `gmail_proxy` opens already recorded within ±20 s of the beacon are **retroactively** reclassified to `sender`, and `is_first` is recomputed.

   Beacons from any other account (including another of the same user's accounts) are ignored. If the user's account B receives mail from their account A, B's view is a real open.
7. Otherwise → `other`.

## Click rules

1. Valid `?s=` → `sender`.
2. Empty UA or `BOT_RE` → `bot`.
3. Within **10 s** of send → `bot`. Link scanners (Defender Safe Links, Proofpoint) follow links on delivery, and humans don't.
4. Otherwise `other` (or `gmail_proxy` if that UA appears, which is unusual).

Clicks are always redirected to the registered URL, whatever the classification.

## Dedupe

Events for the same `(message, type, link, ip_hash, ua_class)` within **30 s** collapse into one: only the first is stored. Different classes from the same IP are kept separately.

## `is_first`

After each insert, and after a self-view reclassification, `is_first` is recomputed:
* opens: the earliest counted (`gmail_proxy` | `other`) open of the message;
* clicks: the earliest counted click per link.

Notifications fire only for `is_first` opens. Clicks are batched per message per poll.

## Settle window

`GET /v1/events` withholds events younger than **20 s**, stopping at the first unsettled id so the cursor stays contiguous. That gives a late self-view beacon time to reclassify an open before the extension can notify about it.

## Known limitations (also in README)

* **Image blocking.** Recipients who block images never trigger the pixel, so "not opened" ≠ "not read".
* **MPP inflation.** Apple prefetches can make every Apple Mail recipient look "opened". Postmark shows these as "possibly auto-loaded" and doesn't notify on them, but MPP re-fetches after 120 s can still look like real opens.
* **Proxy caching.** We send `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `Expires: 0`, but Gmail's proxy may still serve repeat views from cache. Repeat-open counts are a lower bound.
* **Gmail self-view race.** If the sender opens the message in Gmail more than 20 s before or after the extension's beacon (e.g. the extension isn't loaded in that tab, or a different browser/phone), the proxy fetch counts as an open. Opening your own sent mail on your phone will look like a recipient open.
* **Shared IPs.** Corporate NATs make different people share an `ip_hash`, so "unique opens" is approximate.
* **Forwarding.** If a recipient forwards the email, the new readers' opens count toward the original message.
