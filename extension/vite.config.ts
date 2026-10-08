import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { buildManifest } from './manifest.config';

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
  return {
    envDir: resolve(__dirname, '..'),
    plugins: [preact(), crx({ manifest: buildManifest(server) }), inboxSdkPageWorld()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: 'chrome116',
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
