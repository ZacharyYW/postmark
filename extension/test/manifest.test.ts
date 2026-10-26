// @vitest-environment node
// Node environment: manifest.config imports @crxjs/vite-plugin (esbuild), which rejects jsdom.
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../manifest.config';
import { GMAIL_PATTERN } from '../src/ui/permissions';

const SERVER = 'https://pm.example.com';

describe('buildManifest per browser', () => {
  it('chrome: service worker, options_page, no gecko settings', () => {
    const m = buildManifest(SERVER, 'chrome') as unknown as Record<string, unknown>;
    expect(m.background).toEqual({ service_worker: 'src/background/index.ts', type: 'module' });
    expect(m.options_page).toBe('options.html');
    expect(m.minimum_chrome_version).toBe('116');
    expect(m.browser_specific_settings).toBeUndefined();
  });

  it('firefox: background scripts, options_ui, gecko id + min version + data consent', () => {
    const m = buildManifest(SERVER, 'firefox', 'postmark@example.com') as unknown as Record<
      string,
      unknown
    >;
    expect(m.background).toEqual({ scripts: ['src/background/index.ts'], type: 'module' });
    expect(m.options_page).toBeUndefined();
    expect(m.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
    expect(m.minimum_chrome_version).toBeUndefined();
    expect(m.browser_specific_settings).toEqual({
      gecko: {
        id: 'postmark@example.com',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['personalCommunications'] },
      },
    });
    expect(m.host_permissions).toEqual([GMAIL_PATTERN, 'https://pm.example.com/*']);
  });
});
