/** Namespaced Shadow-DOM host so Gmail's CSS can't leak in and ours can't leak out. */
export function createShadowHost(css: string): { host: HTMLElement; mount: HTMLElement } {
  const host = document.createElement('postmark-ui');
  host.style.display = 'block';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const mount = document.createElement('div');
  mount.className = 'pm-root';
  root.append(style, mount);
  applyTheme(host);
  return { host, mount };
}

/**
 * Gmail's theme isn't exposed via a stable API, so infer it from the rendered background
 * luminance (no obfuscated class names). Falls back to prefers-color-scheme in CSS.
 */
export function detectGmailDark(doc: Document = document): boolean | null {
  try {
    const bg = getComputedStyle(doc.body).backgroundColor;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(bg);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum < 0.4;
  } catch {
    return null;
  }
}

export function applyTheme(host: HTMLElement): void {
  const dark = detectGmailDark();
  if (dark === null) host.removeAttribute('data-theme');
  else host.setAttribute('data-theme', dark ? 'dark' : 'light');
}
