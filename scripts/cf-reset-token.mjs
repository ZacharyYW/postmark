#!/usr/bin/env node
/**
 * Issue a new login token for an existing account on your Cloudflare deployment (e.g. after
 * reinstalling the extension). Requires your Cloudflare login, so only you can do it.
 *
 *   npm run cf:reset-token -- --email you@gmail.com
 * Then: Postmark → Options → "Connect with an existing token" → paste the printed token.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  DEPLOY_CONFIG,
  EMAIL_RE,
  argValue,
  fail,
  readDeployConfig,
  wrangler,
} from './cf-common.mjs';

if (!readDeployConfig()) fail('No deploy config found. Run npm run deploy:cloudflare first.');
const email = (argValue('email') ?? '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) fail('Usage: npm run cf:reset-token -- --email you@gmail.com');

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const sql = `UPDATE users SET token_hash = '${hash}' WHERE email = '${email}'; SELECT changes() AS changed;`;
const r = await wrangler(
  ['d1', 'execute', 'postmark', '--remote', '--json', '--config', DEPLOY_CONFIG, '--command', sql],
  { quiet: true },
);
if (r.code !== 0) fail(`wrangler failed:\n${r.out}`);
const changed = /"changed":\s*1/.test(r.out);
if (!changed)
  fail(`No account found for ${email}. Register it from the extension's Options page instead.`);
console.log(`\n✓ New token for ${email} (the old one no longer works):\n\n  ${token}\n
Paste it in Postmark → Options → "Connect with an existing token".`);
