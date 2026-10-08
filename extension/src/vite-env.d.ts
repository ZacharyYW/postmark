/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POSTMARK_SERVER?: string;
  readonly VITE_INBOXSDK_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
