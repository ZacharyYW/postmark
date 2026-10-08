/**
 * Seeds a demo user with tracked messages from TWO Gmail sender accounts, plus opens, clicks
 * and a reminder. Talks to a running server over HTTP (works with docker compose too).
 *
 *   npm run seed                      # registers demo-<timestamp>@postmark.local
 *   npm run seed -- --email me@x.com  # choose the Postmark login email
 *   npm run seed -- --fast            # skip the 11 s wait (opens will be classified as the sender's own)
 */
import { api, argValue, hasFlag, hit, saveToken, SERVER, sleep, USER_AGENTS } from './lib';

interface CreateRes {
  messageId: string;
  pixelUrl: string;
  rewrittenLinks: { original: string; trackedUrl: string }[];
}

const ACCOUNTS = ['alex.work@example.com', 'alex.personal@gmail.com'];

const MESSAGES = [
  {
    account: ACCOUNTS[0]!,
    subject: 'Q3 proposal — draft for review',
    to: ['dana@client.example'],
    links: ['https://example.com/proposal', 'https://example.com/pricing'],
    thread: 'demo-thread-0001',
  },
  {
    account: ACCOUNTS[0]!,
    subject: 'Follow-up: onboarding call',
    to: ['sam@partner.example', 'lee@partner.example'],
    links: ['https://calendar.example.com/book'],
    thread: 'demo-thread-0002',
  },
  {
    account: ACCOUNTS[0]!,
    subject: 'Invoice #1042',
    to: ['billing@vendor.example'],
    links: [],
    thread: 'demo-thread-0003',
  },
  {
    account: ACCOUNTS[1]!,
    subject: 'Weekend plans?',
    to: ['jo@friends.example'],
    links: ['https://maps.example.com/place'],
    thread: 'demo-thread-0101',
  },
  {
    account: ACCOUNTS[1]!,
    subject: 'Photos from the trip',
    to: ['kim@friends.example', ACCOUNTS[0]!],
    links: ['https://photos.example.com/album'],
    thread: 'demo-thread-0102',
  },
];

async function main() {
  const email = argValue('email') ?? `demo-${Date.now()}@postmark.local`;
  console.log(`Seeding ${SERVER} as ${email}`);
  const { token } = await api<{ token: string }>('/v1/auth/register', {
    method: 'POST',
    json: { email },
  });
  saveToken(token);

  const created: (CreateRes & { account: string; subject: string })[] = [];
  for (const m of MESSAGES) {
    const res = await api<CreateRes>('/v1/messages', {
      method: 'POST',
      token,
      json: { senderAccount: m.account, subject: m.subject, recipients: m.to, links: m.links },
    });
    await api(`/v1/messages/${res.messageId}`, {
      method: 'PATCH',
      token,
      json: { gmailThreadId: m.thread, gmailMessageId: `${m.thread}-m` },
    });
    created.push({ ...res, account: m.account, subject: m.subject });
  }
  console.log(`Created ${created.length} messages across ${ACCOUNTS.length} accounts.`);

  if (!hasFlag('fast')) {
    console.log('Waiting 11 s so demo opens are not treated as the sender’s own (10 s grace)…');
    await sleep(11_000);
  }

  const [m0, m1, , m3, m4] = created;
  await hit(m0!.pixelUrl, USER_AGENTS.gmail_proxy);
  await hit(m0!.pixelUrl, USER_AGENTS.outlook);
  await hit(m0!.rewrittenLinks[0]!.trackedUrl, USER_AGENTS.browser);
  await hit(m1!.pixelUrl, USER_AGENTS.apple_mpp); // "possibly auto-loaded"
  await hit(m3!.pixelUrl, USER_AGENTS.gmail_proxy);
  await hit(m4!.pixelUrl, USER_AGENTS.bot); // excluded
  await hit(m4!.rewrittenLinks[0]!.trackedUrl, USER_AGENTS.bot); // excluded

  await api('/v1/reminders', {
    method: 'POST',
    token,
    json: {
      messageId: created[2]!.messageId,
      remindAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      condition: 'no_open',
    },
  });
  await api(`/v1/accounts/${encodeURIComponent(ACCOUNTS[1]!)}`, {
    method: 'PATCH',
    token,
    json: { notificationsEnabled: false },
  });

  const { messages } = await api<{
    messages: {
      subject: string;
      senderAccount: string;
      status: string;
      opens: { total: number; autoLoaded: number };
      clicks: { total: number };
    }[];
  }>('/v1/messages', { token });
  console.table(
    messages.map((m) => ({
      account: m.senderAccount,
      subject: m.subject,
      status: m.status,
      opens: m.opens.total,
      autoLoaded: m.opens.autoLoaded,
      clicks: m.clicks.total,
    })),
  );
  console.log('\nDemo token saved to .postmark-demo-token (git-ignored).');
  console.log(
    'To view this data in the extension: Options → "Connect with an existing token" and paste:',
  );
  console.log(`  ${token}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
