import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

/** Host match pattern for an origin (Chrome match patterns ignore ports). */
export function originMatchPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

export function buildManifest(serverUrl: string) {
  return defineManifest({
    manifest_version: 3,
    name: 'Postmark — read receipts for Gmail',
    short_name: 'Postmark',
    version: pkg.version,
    description:
      'Probabilistic open and link-click tracking for Gmail, with follow-up reminders. Talks only to your own Postmark server.',
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_title: 'Postmark',
      default_popup: 'popup.html',
      default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png' },
    },
    options_page: 'options.html',
    background: { service_worker: 'src/background/index.ts', type: 'module' },
    content_scripts: [
      {
        matches: ['https://mail.google.com/*'],
        js: ['src/gmail/content.ts'],
        run_at: 'document_end',
        all_frames: false,
      },
    ],
    // `scripting` is required by @inboxsdk/core's MV3 background helper (see docs/DECISIONS.md D-001).
    permissions: ['storage', 'alarms', 'notifications', 'scripting'],
    host_permissions: ['https://mail.google.com/*', originMatchPattern(serverUrl)],
    // Lets the user point the extension at a different self-hosted server from Options.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'].filter(
      (p) => p !== originMatchPattern(serverUrl),
    ),
    web_accessible_resources: [
      { resources: ['icons/*.svg'], matches: ['https://mail.google.com/*'] },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
    minimum_chrome_version: '116',
  });
}
