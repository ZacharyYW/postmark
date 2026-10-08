/** 4, 6, or 0 (not an IP). Self-contained so it runs on Node and Cloudflare Workers alike. */
export function isIP(ip: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip))
    return 4;
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return 0;
  const doubleColons = ip.split('::').length - 1;
  if (doubleColons > 1) return 0;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4 && isIP(v4[1] ?? '') !== 4) return 0;
  // Count hex groups (an embedded IPv4 tail stands in for two groups).
  const nonEmpty = ip
    .replace(/(\d+\.\d+\.\d+\.\d+)$/, '0:0')
    .split(':')
    .filter(Boolean);
  if (nonEmpty.some((g) => g.length > 4)) return 0;
  if (doubleColons === 0 && nonEmpty.length !== 8) return 0;
  if (doubleColons === 1 && nonEmpty.length > 7) return 0;
  return 6;
}

interface Cidr {
  version: 4 | 6;
  base: bigint;
  mask: bigint;
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  // Handle embedded IPv4 (::ffff:1.2.3.4)
  let addr = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4?.[1]) {
    const n = ipv4ToBigInt(v4[1]);
    addr = addr.replace(v4[1], `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`);
  }
  const [head = '', tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailParts];
  return parts.reduce((acc, h) => (acc << 16n) + BigInt(parseInt(h || '0', 16)), 0n);
}

/** Normalise IPv4-mapped IPv6 (::ffff:a.b.c.d) to plain IPv4. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

export function parseCidr(cidr: string): Cidr | null {
  const [ip, bitsRaw] = cidr.trim().split('/');
  if (!ip) return null;
  const version = isIP(ip);
  if (version !== 4 && version !== 6) return null;
  const total = version === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? total : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > total) return null;
  const all = (1n << BigInt(total)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(total - bits)) & all;
  const base = (version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip)) & mask;
  return { version, base, mask };
}

export function parseCidrList(list: string): Cidr[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);
}

export function ipInCidrs(rawIp: string, cidrs: readonly Cidr[]): boolean {
  const ip = normalizeIp(rawIp);
  const version = isIP(ip);
  if (version !== 4 && version !== 6) return false;
  const n = version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
  return cidrs.some((c) => c.version === version && (n & c.mask) === c.base);
}
