import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildManifest, DEV_GECKO_ID, type TargetBrowser } from './manifest.config';

const require = createRequire(import.meta.url);

/** InboxSDK's MV3 background helper injects `pageWorld.js` from the extension root. */
function inboxSdkPageWorld(): Plugin {
  return {
    name: 'postmark:inboxsdk-pageworld',
    generateBundle() {
      const src = require.resolve('@inboxsdk/core/pageWorld.js');
      this.emitFile({ type: 'asset', fileName: 'pageWorld.js', source: readFileSync(src) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '..'), 'VITE_');
  const server = env.VITE_POSTMARK_SERVER || 'http://localhost:8787';
  const browser: TargetBrowser = process.env.TARGET_BROWSER === 'firefox' ? 'firefox' : 'chrome';
  const manifest = buildManifest(server, browser, env.VITE_GECKO_ID || DEV_GECKO_ID);
  return {
    envDir: resolve(__dirname, '..'),
    define: { 'import.meta.env.VITE_TARGET_BROWSER': JSON.stringify(browser) },
    plugins: [preact(), crx({ manifest, browser }), inboxSdkPageWorld()],
    build: {
      outDir: `dist/${browser}`,
      emptyOutDir: true,
      sourcemap: false,
      target: browser === 'firefox' ? 'firefox140' : 'chrome116',
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'popup.html'),
          options: resolve(__dirname, 'options.html'),
        },
      },
    },
    server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
  };
});
