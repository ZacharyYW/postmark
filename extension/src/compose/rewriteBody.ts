import { isTrackableHref, toOrigin } from '@postmark/shared';

/**
 * Pure HTML transforms for the outgoing email body. No network, no Gmail APIs: input HTML in,
 * output HTML out. Only the *fresh* part of the body (what the user just typed, including their
 * signature) is touched; quoted reply/forward content is left alone.
 */

export const QUOTE_SELECTORS = [
  '.gmail_quote_container',
  '.gmail_quote',
  'blockquote[type="cite"]',
  '.gmail_extra',
  '.moz-cite-prefix',
  '#divRplyFwdMsg',
  '#appendonsend',
] as const;
const QUOTE_SELECTOR = QUOTE_SELECTORS.join(',');

export const PIXEL_MARKER_ATTR = 'data-postmark';
export const DISCLOSURE_TEXT = 'Read receipts enabled (Postmark)';

export interface TrackingPayload {
  trackingOrigin: string;
  pixelUrl: string;
  rewrittenLinks: { original: string; trackedUrl: string }[];
  disclosureFooter?: boolean;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
    'text/html',
  );
}

function isQuoted(el: Element): boolean {
  return el.closest(QUOTE_SELECTOR) !== null;
}

/** The first top-level quoted block, if any (insertion point for the pixel). */
export function findQuoteStart(root: ParentNode): Element | null {
  const first = root.querySelector(QUOTE_SELECTOR);
  if (!first) return null;
  // Walk up to the outermost quote container.
  let top: Element = first;
  let parent = top.parentElement?.closest(QUOTE_SELECTOR) ?? null;
  while (parent) {
    top = parent;
    parent = top.parentElement?.closest(QUOTE_SELECTOR) ?? null;
  }
  return top;
}

function freshAnchors(doc: Document): HTMLAnchorElement[] {
  return [...doc.body.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((a) => !isQuoted(a));
}

function isPostmarkPixel(img: HTMLImageElement, trackingOrigin: string): boolean {
  if (img.hasAttribute(PIXEL_MARKER_ATTR)) return true;
  const origin = toOrigin(trackingOrigin);
  if (!origin) return false;
  const src = img.getAttribute('src') ?? '';
  // Gmail may rewrite draft images to googleusercontent proxy URLs that embed the original after '#'.
  return src.startsWith(`${origin}/p/`) || src.includes(`#${origin}/p/`);
}

/** True when the fresh part of the body already carries a Postmark pixel (resend / reopened draft). */
export function hasPostmarkPixel(html: string, trackingOrigin: string): boolean {
  const doc = parse(html);
  return [...doc.body.querySelectorAll<HTMLImageElement>('img')].some(
    (img) => !isQuoted(img) && isPostmarkPixel(img, trackingOrigin),
  );
}

/** Eligible links in the fresh part, de-duplicated, in document order. */
export function collectLinks(html: string, trackingOrigin: string): string[] {
  const doc = parse(html);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of freshAnchors(doc)) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (!isTrackableHref(href, trackingOrigin) || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

/** Rewrite fresh-part hrefs to tracked URLs and insert the pixel (+ optional disclosure line). */
export function applyTracking(html: string, p: TrackingPayload): string {
  const doc = parse(html);
  const map = new Map(p.rewrittenLinks.map((l) => [l.original, l.trackedUrl]));
  for (const a of freshAnchors(doc)) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (!isTrackableHref(href, p.trackingOrigin)) continue;
    const tracked = map.get(href);
    if (tracked) a.setAttribute('href', tracked); // text & children untouched
  }

  const pixel = doc.createElement('img');
  pixel.setAttribute('src', p.pixelUrl);
  pixel.setAttribute('width', '1');
  pixel.setAttribute('height', '1');
  pixel.setAttribute('style', 'display:none');
  pixel.setAttribute('alt', '');
  pixel.setAttribute(PIXEL_MARKER_ATTR, '1');

  const nodes: Node[] = [];
  if (p.disclosureFooter) {
    const footer = doc.createElement('div');
    footer.setAttribute('style', 'color:#888888;font-size:11px;margin-top:12px');
    footer.textContent = DISCLOSURE_TEXT;
    nodes.push(footer);
  }
  nodes.push(pixel);

  const quoteStart = findQuoteStart(doc.body);
  for (const n of nodes) {
    if (quoteStart?.parentNode) quoteStart.parentNode.insertBefore(n, quoteStart);
    else doc.body.appendChild(n);
  }
  return doc.body.innerHTML;
}
