/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POSTMARK_SERVER?: string;
  readonly VITE_INBOXSDK_APP_ID?: string;
  /** Set at build time by vite.config.ts. */
  readonly VITE_TARGET_BROWSER?: 'chrome' | 'firefox';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
