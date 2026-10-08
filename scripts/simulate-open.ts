/**
 * Hit a tracking pixel (and optionally a link) with different user agents so you can demo
 * Postmark without a second inbox.
 *
 *   npm run simulate                         # latest tracked message, all profiles
 *   npm run simulate -- --pixel <pixelId>    # a specific pixel
 *   npm run simulate -- --message <id> --profiles gmail_proxy,apple_mpp
 *   npm run simulate -- --click              # also click the first tracked link
 *   npm run simulate -- --account me@x.com   # latest message from that sender account
 *
 * Profiles: gmail_proxy, apple_mpp, apple_mail, outlook, browser, bot, curl
 * Note: identical (IP, class) hits within 30 s are deduplicated by design.
 */
import { api, argValue, hasFlag, hit, readToken, SERVER, USER_AGENTS, type Profile } from './lib';

interface Summary {
  id: string;
  subject: string;
  senderAccount: string;
  sentAt: string;
  status: string;
  opens: { total: number; autoLoaded: number };
  clicks: { total: number };
  links: { id: string; originalUrl: string }[];
}

async function main() {
  const profiles = (argValue('profiles') ?? Object.keys(USER_AGENTS).join(','))
    .split(',')
    .map((p) => p.trim())
    .filter((p): p is Profile => p in USER_AGENTS);

  let pixelUrl: string | null = null;
  let messageId = argValue('message') ?? null;
  const pixelId = argValue('pixel');
  let token: string | null = null;

  if (pixelId) {
    pixelUrl = `${SERVER}/p/${pixelId}.gif`;
  } else {
    token = readToken();
    let target: Summary | undefined;
    if (messageId) {
      target = await api<Summary>(`/v1/messages/${messageId}`, { token });
    } else {
      const account = argValue('account');
      const q = account ? `?limit=1&account=${encodeURIComponent(account)}` : '?limit=1';
      target = (await api<{ messages: Summary[] }>(`/v1/messages${q}`, { token })).messages[0];
    }
    if (!target)
      throw new Error('No tracked messages found. Send one from Gmail or run `npm run seed`.');
    messageId = target.id;
    console.log(`Target: "${target.subject}" from ${target.senderAccount} (sent ${target.sentAt})`);
    pixelUrl = (await api<{ pixelUrl: string }>(`/v1/messages/${messageId}/pixel`, { token }))
      .pixelUrl;
  }
  if (!pixelUrl) throw new Error('Could not resolve pixel URL');

  for (const p of profiles) {
    const status = await hit(pixelUrl, USER_AGENTS[p]);
    console.log(`open  ${p.padEnd(12)} → HTTP ${status}`);
  }

  if (hasFlag('click') && token && messageId) {
    const s = await api<Summary>(`/v1/messages/${messageId}`, { token });
    const link = s.links[0];
    if (link) {
      const status = await hit(`${SERVER}/l/${link.id}`, USER_AGENTS.browser);
      console.log(`click browser      → HTTP ${status} (${link.originalUrl})`);
    } else {
      console.log('click skipped: message has no tracked links');
    }
  }

  if (token && messageId) {
    const s = await api<Summary>(`/v1/messages/${messageId}`, { token });
    console.log(
      `\nNow: status=${s.status} opens=${s.opens.total} possiblyAutoLoaded=${s.opens.autoLoaded} clicks=${s.clicks.total}`,
    );
    console.log('Opens younger than 10 s after send count as the sender’s own; bots are excluded.');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
