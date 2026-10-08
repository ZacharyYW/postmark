import { TIMING, type UaClass } from '@postmark/shared';

/**
 * Coarse requester classification. Every rule here is a heuristic; see docs/OPEN_DETECTION.md.
 * These functions are pure: all context (time since send, IP-range match, signature validity)
 * is computed by the caller.
 */

export interface ClassifyInput {
  ua: string | null | undefined;
  /** ms between the message's sent_at and this request. */
  msSinceSent: number;
  /** IP falls in a configured Apple MPP egress range. */
  ipInMppRange: boolean;
  /** Request carried a valid `?s=` sender signature. */
  senderSigValid: boolean;
}

export const GMAIL_PROXY_RE = /GoogleImageProxy|via ggpht\.com/i;

/**
 * Security scanners, link pre-fetchers, CLI tools and crawlers. Deliberately excludes
 * "Microsoft Office" (Outlook desktop's real UA) and generic "Mozilla/5.0".
 */
export const BOT_RE = new RegExp(
  [
    'bot\\b',
    'bot/',
    'crawler',
    'spider',
    'slurp',
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'aiohttp',
    'httpx',
    'go-http-client',
    'java/',
    'okhttp',
    'libwww-perl',
    'apache-httpclient',
    'node-fetch',
    'undici',
    'axios/',
    'headlesschrome',
    'phantomjs',
    'barracuda',
    'proofpoint',
    'mimecast',
    'symantec',
    'messagelabs',
    'forcepoint',
    'trendmicro',
    'trend micro',
    'sophos',
    'fortiguard',
    'ironport',
    'cisco',
    'zscaler',
    'safelinks',
    'microsoft office protection',
    'bingpreview',
    'facebookexternalhit',
    'slackbot',
    'skypeuripreview',
    'whatsapp',
    'zgrab',
    'masscan',
    'nmap',
    'nessus',
    'censys',
    'scanner',
    'virustotal',
    'urlscan',
  ].join('|'),
  'i',
);

/** Apple Mail's WebKit UA: AppleWebKit without a browser product token. */
export function isAppleMailShaped(ua: string): boolean {
  return /AppleWebKit/i.test(ua) && !/Safari|Chrome|CriOS|Firefox|FxiOS|Edg\//i.test(ua);
}

/** MPP's proxy fetches have been observed with a bare "Mozilla/5.0" UA. */
export function isBareMozilla(ua: string): boolean {
  return /^Mozilla\/5\.0$/i.test(ua.trim());
}

export function classifyOpen(i: ClassifyInput): UaClass {
  const ua = (i.ua ?? '').trim();
  if (i.senderSigValid || i.msSinceSent < TIMING.SELF_OPEN_GRACE_MS) return 'sender';
  if (GMAIL_PROXY_RE.test(ua)) return 'gmail_proxy';
  if (ua === '' || BOT_RE.test(ua)) return 'bot';
  if (i.ipInMppRange || isBareMozilla(ua)) return 'apple_mpp';
  if (isAppleMailShaped(ua) && i.msSinceSent < TIMING.MPP_PREFETCH_WINDOW_MS) return 'apple_mpp';
  return 'other';
}

export function classifyClick(i: ClassifyInput): UaClass {
  const ua = (i.ua ?? '').trim();
  if (i.senderSigValid) return 'sender';
  if (ua === '' || BOT_RE.test(ua)) return 'bot';
  // Humans don't click within seconds of send; link scanners on delivery do.
  if (i.msSinceSent < TIMING.CLICK_SCANNER_WINDOW_MS) return 'bot';
  // Gmail proxies images, not link clicks; a click with the proxy UA is unusual but counted.
  if (GMAIL_PROXY_RE.test(ua)) return 'gmail_proxy';
  return 'other';
}
