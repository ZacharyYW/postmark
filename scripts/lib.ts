import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SERVER = (process.env.POSTMARK_SERVER ?? 'http://localhost:8787').replace(/\/+$/, '');
export const TOKEN_FILE = resolve(process.cwd(), '.postmark-demo-token');

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function readToken(): string {
  const fromArg = argValue('token') ?? process.env.POSTMARK_TOKEN;
  if (fromArg) return fromArg;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  throw new Error('No token: run `npm run seed` first, or pass --token / POSTMARK_TOKEN.');
}

export function saveToken(token: string): void {
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
}

export async function api<T>(
  path: string,
  init: RequestInit & { token?: string; json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${SERVER}${path}`, { ...init, headers, body });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const USER_AGENTS = {
  gmail_proxy:
    'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)',
  apple_mpp: 'Mozilla/5.0',
  apple_mail:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  outlook: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17328; Pro)',
  browser:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; Proofpoint URL Defense)',
  curl: 'curl/8.4.0',
} as const;
export type Profile = keyof typeof USER_AGENTS;

export async function hit(url: string, ua: string): Promise<number> {
  const res = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'manual' });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}
