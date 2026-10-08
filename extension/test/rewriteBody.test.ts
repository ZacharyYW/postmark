import { describe, expect, it } from 'vitest';
import {
  applyTracking,
  collectLinks,
  DISCLOSURE_TEXT,
  findQuoteStart,
  hasPostmarkPixel,
} from '../src/compose/rewriteBody';

const ORIGIN = 'https://pm.example.com';
const PIXEL = `${ORIGIN}/p/PIXELPIXELPIXELPIXELP.gif`;

function track(html: string, opts: { footer?: boolean } = {}) {
  const links = collectLinks(html, ORIGIN);
  const rewrittenLinks = links.map((original, i) => ({
    original,
    trackedUrl: `${ORIGIN}/l/LINK${i}`,
  }));
  const out = applyTracking(html, {
    trackingOrigin: ORIGIN,
    pixelUrl: PIXEL,
    rewrittenLinks,
    disclosureFooter: opts.footer ?? false,
  });
  const doc = new DOMParser().parseFromString(out, 'text/html');
  return { links, out, doc };
}

describe('collectLinks', () => {
  it('collects http(s) links in order and dedupes', () => {
    expect(
      collectLinks(
        '<a href="https://a.com">a</a> <a href="http://b.com/x?y=1&amp;z=2">b</a> <a href="https://a.com">again</a>',
        ORIGIN,
      ),
    ).toEqual(['https://a.com', 'http://b.com/x?y=1&z=2']);
  });

  it.each([
    ['mailto', '<a href="mailto:x@y.com">mail</a>'],
    ['tel', '<a href="tel:+15551234">call</a>'],
    ['anchor', '<a href="#top">top</a>'],
    ['relative', '<a href="/path">rel</a>'],
    ['javascript', '<a href="javascript:alert(1)">js</a>'],
    ['already tracked', `<a href="${ORIGIN}/l/abc">t</a>`],
    ['empty', '<a href="">e</a>'],
    ['no href', '<a name="x">n</a>'],
    ['data uri', '<a href="data:text/html,hi">d</a>'],
  ])('skips %s links', (_n, html) => {
    expect(collectLinks(html, ORIGIN)).toEqual([]);
  });

  it('trims whitespace in hrefs', () => {
    expect(collectLinks('<a href="  https://a.com/x  ">a</a>', ORIGIN)).toEqual([
      'https://a.com/x',
    ]);
  });

  it('ignores links inside Gmail quoted replies', () => {
    const html = `<div>New <a href="https://new.com">link</a></div>
      <div class="gmail_quote"><div class="gmail_attr">On Mon, X wrote:</div>
      <blockquote class="gmail_quote"><a href="https://old.com">old</a></blockquote></div>`;
    expect(collectLinks(html, ORIGIN)).toEqual(['https://new.com']);
  });

  it('ignores links in blockquote[type=cite] and .gmail_extra', () => {
    const html = `<a href="https://keep.com">k</a><blockquote type="cite"><a href="https://q1.com">q</a></blockquote><div class="gmail_extra"><a href="https://q2.com">q</a></div>`;
    expect(collectLinks(html, ORIGIN)).toEqual(['https://keep.com']);
  });

  it('tracks links in the signature (fresh content)', () => {
    const html = `Hi<div class="gmail_signature"><a href="https://me.dev">site</a></div>`;
    expect(collectLinks(html, ORIGIN)).toEqual(['https://me.dev']);
  });
});

describe('applyTracking', () => {
  it('rewrites hrefs but keeps visible text and nested markup', () => {
    const { doc } = track('<p>See <a href="https://a.com"><b>bold</b> <i>text</i></a></p>');
    const a = doc.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(`${ORIGIN}/l/LINK0`);
    expect(a.innerHTML).toBe('<b>bold</b> <i>text</i>');
  });

  it('rewrites links wrapping images without touching the image', () => {
    const { doc } = track(
      '<a href="https://shop.com"><img src="https://cdn.com/banner.png" alt="Banner"></a>',
    );
    expect(doc.querySelector('a')!.getAttribute('href')).toBe(`${ORIGIN}/l/LINK0`);
    expect(doc.querySelector('a img')!.getAttribute('src')).toBe('https://cdn.com/banner.png');
  });

  it('rewrites every occurrence of a repeated URL to the same tracked link', () => {
    const { doc } = track('<a href="https://a.com">1</a><a href="https://a.com">2</a>');
    expect([...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      `${ORIGIN}/l/LINK0`,
      `${ORIGIN}/l/LINK0`,
    ]);
  });

  it('leaves mailto and quoted links unchanged', () => {
    const html = `<a href="mailto:a@b.com">m</a><div class="gmail_quote"><a href="https://old.com">o</a></div>`;
    const { doc } = track(html);
    expect(doc.querySelector('a[href^="mailto"]')).not.toBeNull();
    expect(doc.querySelector('.gmail_quote a')!.getAttribute('href')).toBe('https://old.com');
  });

  it('appends a hidden 1x1 pixel at the end when there is no quote', () => {
    const { doc } = track('<div>Hello</div>');
    const img = doc.body.lastElementChild as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(PIXEL);
    expect(img.getAttribute('width')).toBe('1');
    expect(img.getAttribute('height')).toBe('1');
    expect(img.getAttribute('style')).toBe('display:none');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('inserts the pixel before the quoted reply block', () => {
    const html = `<div>Reply text</div><div class="gmail_quote_container"><div class="gmail_quote">quoted</div></div>`;
    const { doc } = track(html);
    const quote = doc.querySelector('.gmail_quote_container')!;
    expect(quote.previousElementSibling?.tagName).toBe('IMG');
    expect(quote.querySelector('img')).toBeNull();
  });

  it('inserts before a nested quote within its parent', () => {
    const html = `<div dir="ltr"><div>Hi</div><blockquote type="cite">old</blockquote></div>`;
    const { doc } = track(html);
    expect(doc.querySelector('blockquote')!.previousElementSibling?.tagName).toBe('IMG');
  });

  it('adds the disclosure footer before the pixel when enabled', () => {
    const { doc } = track('<div>Hello</div>', { footer: true });
    const img = doc.querySelector('img[data-postmark]')!;
    expect(img.previousElementSibling?.textContent).toBe(DISCLOSURE_TEXT);
  });

  it('does not add the footer when disabled', () => {
    const { out } = track('<div>Hello</div>');
    expect(out).not.toContain(DISCLOSURE_TEXT);
  });

  it('handles an empty body', () => {
    const { doc } = track('');
    expect(doc.querySelectorAll('img')).toHaveLength(1);
  });

  it('escapes hostile tracked URLs safely (no attribute injection)', () => {
    const out = applyTracking('<a href="https://a.com">x</a>', {
      trackingOrigin: ORIGIN,
      pixelUrl: `${ORIGIN}/p/x.gif" onerror="alert(1)`,
      rewrittenLinks: [{ original: 'https://a.com', trackedUrl: `${ORIGIN}/l/a" onclick="evil()` }],
    });
    const doc = new DOMParser().parseFromString(out, 'text/html');
    expect(doc.querySelector('[onclick]')).toBeNull();
    expect(doc.querySelector('[onerror]')).toBeNull();
  });

  it('preserves inline images and other content', () => {
    const html =
      '<div><img src="cid:ii_abc" alt="inline"> text <table><tr><td>cell</td></tr></table></div>';
    const { doc } = track(html);
    expect(doc.querySelector('img[src="cid:ii_abc"]')).not.toBeNull();
    expect(doc.querySelector('td')!.textContent).toBe('cell');
  });

  it('copes with large bodies', () => {
    const big = Array.from(
      { length: 2000 },
      (_, i) => `<p>Line ${i} <a href="https://x.com/${i % 50}">l</a></p>`,
    ).join('');
    const { links, doc } = track(big);
    expect(links).toHaveLength(50);
    expect(doc.querySelectorAll(`a[href^="${ORIGIN}/l/"]`)).toHaveLength(2000);
  });
});

describe('hasPostmarkPixel / findQuoteStart', () => {
  it('detects our pixel in the fresh part', () => {
    expect(hasPostmarkPixel(`<div>x</div><img src="${PIXEL}">`, ORIGIN)).toBe(true);
    expect(
      hasPostmarkPixel(
        '<img data-postmark="1" src="https://ci3.googleusercontent.com/proxy/abc">',
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      hasPostmarkPixel(`<img src="https://ci3.googleusercontent.com/proxy/abc#${PIXEL}">`, ORIGIN),
    ).toBe(true);
  });

  it('ignores pixels inside quoted content (replying to a tracked email)', () => {
    expect(
      hasPostmarkPixel(
        `<div>reply</div><div class="gmail_quote"><img src="${PIXEL}"></div>`,
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('ignores other images', () => {
    expect(hasPostmarkPixel('<img src="https://other.com/p/x.gif">', ORIGIN)).toBe(false);
  });

  it('findQuoteStart returns the outermost quote', () => {
    const doc = new DOMParser().parseFromString(
      '<div class="gmail_quote_container"><div class="gmail_quote"><blockquote class="gmail_quote">x</blockquote></div></div>',
      'text/html',
    );
    expect(findQuoteStart(doc.body)?.className).toBe('gmail_quote_container');
  });
});

describe('odd bodies (R2 break tests)', () => {
  it('full HTML documents, comments and stray markup', () => {
    const html =
      '<html><head><style>p{}</style></head><body><!-- c --><p>Hi <a href="https://a.com">a</a></p></body></html>';
    const { out } = track(html);
    expect(out).toContain(`${ORIGIN}/l/LINK0`);
    expect(out).toContain('<img');
  });

  it('uppercase schemes, newlines and entities in hrefs', () => {
    const links = collectLinks(
      '<a href="HTTPS://Example.com/A">x</a><a href="\n https://b.com/x?a=1&amp;b=2 \n">y</a>',
      ORIGIN,
    );
    expect(links).toEqual(['HTTPS://Example.com/A', 'https://b.com/x?a=1&b=2']);
  });

  it('malformed nested anchors do not crash', () => {
    const { doc } = track(
      '<a href="https://outer.com">outer <a href="https://inner.com">inner</a></a>',
    );
    expect(doc.querySelectorAll(`a[href^="${ORIGIN}/l/"]`).length).toBeGreaterThan(0);
  });

  it('RTL text and emoji survive untouched', () => {
    const { out } = track('<div dir="rtl">שלום 👋 <a href="https://a.com">קישור</a></div>');
    expect(out).toContain('שלום 👋');
    expect(out).toContain('קישור');
  });

  it('script tags in a body are not executed or added', () => {
    const { out } = track('<div>x</div><script>window.__pwned = 1</script>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(out.match(/<script/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('only-whitespace and only-quote bodies', () => {
    expect(track('   ').doc.querySelectorAll('img')).toHaveLength(1);
    const { doc } = track(
      '<div class="gmail_quote">only quoted <a href="https://q.com">q</a></div>',
    );
    expect(doc.querySelector('.gmail_quote a')!.getAttribute('href')).toBe('https://q.com');
    expect(doc.querySelector('.gmail_quote')!.previousElementSibling?.tagName).toBe('IMG');
  });
});
