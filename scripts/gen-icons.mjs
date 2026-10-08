// Generates Postmark's original extension icons (PNG) with a tiny SDF rasterizer — no deps.
// Design: ink-blue rounded square, a white postmark ring, and a double check inside.
// Run: node scripts/gen-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../extension/public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = [43, 76, 126]; // #2B4C7E ink blue
const FG = [255, 255, 255];
const ACCENT = [52, 199, 123]; // opened green

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// SDFs in unit space [0,1]
const sdRoundRect = (x, y, r) => {
  const qx = Math.abs(x - 0.5) - (0.5 - r),
    qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (px, py, ax, ay, bx, by) => {
  const pax = px - ax,
    pay = py - ay,
    bax = bx - ax,
    bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
};

function shade(x, y, small) {
  // returns [r,g,b,a]
  if (sdRoundRect(x, y, 0.22) > 0) return [0, 0, 0, 0];
  let col = BG;
  const ring = Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.33) - (small ? 0.045 : 0.03);
  if (ring < 0) col = FG;
  const w = small ? 0.06 : 0.045;
  const check1 =
    Math.min(sdSegment(x, y, 0.27, 0.52, 0.38, 0.63), sdSegment(x, y, 0.38, 0.63, 0.56, 0.4)) - w;
  const check2 =
    Math.min(sdSegment(x, y, 0.45, 0.6, 0.48, 0.63), sdSegment(x, y, 0.48, 0.63, 0.73, 0.38)) - w;
  if (check1 < 0) col = FG;
  if (check2 < 0) col = ACCENT;
  return [...col, 255];
}

function render(size) {
  const ss = 4,
    buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = shade(
            (x + (sx + 0.5) / ss) / size,
            (y + (sy + 0.5) / ss) / size,
            size <= 32,
          );
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      const i = (y * size + x) * 4;
      buf[i] = a ? Math.round(r / a) : 0;
      buf[i + 1] = a ? Math.round(g / a) : 0;
      buf[i + 2] = a ? Math.round(b / a) : 0;
      buf[i + 3] = Math.round(a / (ss * ss));
    }
  return png(size, buf);
}

for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${s}.png`, OUT), render(s));

// 16px SVG marks for Gmail surfaces (loaded as web-accessible resources).
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">${body}</svg>\n`;
const ticks = (c) =>
  `<path d="M1.5 8.5l2.6 2.6L9 5.5" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 10.4l.7.7L14.5 5.5" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
const files = {
  'mark-sent.svg': svg(ticks('#8A94A6')),
  'mark-opened.svg': svg(ticks('#1E9E5A')),
  'mark-auto.svg': svg(`${ticks('#B7791F')}`),
  'mark-click.svg': svg(
    `<path d="M6.6 9.4a2.6 2.6 0 003.7 0l2.2-2.2a2.6 2.6 0 00-3.7-3.7l-.8.8" stroke="#2B6CB0" stroke-width="1.6" stroke-linecap="round"/><path d="M9.4 6.6a2.6 2.6 0 00-3.7 0L3.5 8.8a2.6 2.6 0 003.7 3.7l.8-.8" stroke="#2B6CB0" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  'eye-on.svg': svg(
    `<path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="#2B4C7E"/><circle cx="8" cy="8" r="2.3" fill="#fff"/>`,
  ),
  'eye-off.svg': svg(
    `<path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" stroke="#80868B" stroke-width="1.4"/><circle cx="8" cy="8" r="2" stroke="#80868B" stroke-width="1.4"/><path d="M2.5 13.5l11-11" stroke="#80868B" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
};
for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, OUT), body);
console.log('icons written to extension/public/icons');
