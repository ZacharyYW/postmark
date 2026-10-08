#!/usr/bin/env node
/**
 * One-time (and repeatable) deploy of the Postmark server to Cloudflare Workers + D1 (free tier).
 *
 *   npx -w server wrangler login                         # once: opens the browser
 *   npm run deploy:cloudflare -- --email you@gmail.com   # creates DB, migrates, deploys
 *
 * --email locks registration to that address (others get 403). Re-run any time to redeploy.
 */
import {
  DEPLOY_CONFIG,
  EMAIL_RE,
  argValue,
  fail,
  readDeployConfig,
  wrangler,
  writeDeployConfig,
} from './cf-common.mjs';

const existing = readDeployConfig();
const prevEmail = existing?.match(/ALLOWED_EMAILS = "([^"]*)"/)?.[1];
const email = (argValue('email') ?? prevEmail ?? '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) {
  fail('Pass the email you will sign in with: npm run deploy:cloudflare -- --email you@gmail.com');
}

console.log('1/5 Checking Cloudflare login…');
const who = await wrangler(['whoami'], { quiet: true });
if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
  fail(
    'Not logged in to Cloudflare. Run:  npx -w server wrangler login   then re-run this command.',
  );
}
console.log('   ✓ logged in');

console.log('2/5 Finding or creating the D1 database "postmark"…');
let databaseId = existing?.match(/database_id = "([0-9a-f-]{36})"/)?.[1];
if (!databaseId || /^0{8}-/.test(databaseId)) {
  const list = await wrangler(['d1', 'list', '--json'], { quiet: true });
  try {
    const json = JSON.parse(list.out.slice(list.out.indexOf('[')));
    databaseId = json.find((d) => d.name === 'postmark')?.uuid;
  } catch {
    databaseId = undefined;
  }
  if (!databaseId) {
    const created = await wrangler(['d1', 'create', 'postmark']);
    databaseId = created.out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/)?.[1];
    if (!databaseId) fail('Could not read the new database id from wrangler output (see above).');
  }
}
writeDeployConfig({ databaseId, allowedEmails: email });
console.log(`   ✓ database ${databaseId} (config: ${DEPLOY_CONFIG})`);

console.log('3/5 Applying database migrations…');
const mig = await wrangler([
  'd1',
  'migrations',
  'apply',
  'postmark',
  '--remote',
  '--config',
  DEPLOY_CONFIG,
]);
if (mig.code !== 0) fail('Migration failed (see above).');

console.log('4/5 Deploying the Worker…');
const dep = await wrangler(['deploy', '--config', DEPLOY_CONFIG]);
if (dep.code !== 0) fail('Deploy failed (see above).');
const url = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) fail('Deployed, but could not find the workers.dev URL in the output above.');

console.log('5/5 Health check…');
let ok = false;
for (let i = 0; i < 10 && !ok; i++) {
  try {
    ok = (await fetch(`${url}/healthz`)).ok;
  } catch {
    /* DNS for a brand-new workers.dev subdomain can take a few seconds */
  }
  if (!ok) await new Promise((r) => setTimeout(r, 3000));
}

console.log(`
${ok ? '✓' : '⚠'} Postmark server ${ok ? 'is live' : 'deployed (health check not reachable yet; give it a minute)'}: ${url}

Next, in Chrome:
  1. Postmark → Options → Server URL: ${url}  → Save server (allow the permission prompt)
  2. Register with: ${email}
  3. Reload your Gmail tabs.

Only ${email} can register on this server. To redeploy after code changes, re-run this command.
Lost your token (e.g. reinstalled the extension)? npm run cf:reset-token -- --email ${email}
`);
