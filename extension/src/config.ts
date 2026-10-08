/** Build-time configuration (Vite env). Runtime-changeable values live in chrome.storage. */
export const DEFAULT_SERVER_URL = (
  import.meta.env.VITE_POSTMARK_SERVER || 'http://localhost:8787'
).replace(/\/+$/, '');

export const INBOXSDK_DEV_PLACEHOLDER = 'sdk_POSTMARK_DEV_PLACEHOLDER';
/** Register a real app id at https://www.inboxsdk.com/register and set VITE_INBOXSDK_APP_ID. */
export const INBOXSDK_APP_ID = import.meta.env.VITE_INBOXSDK_APP_ID || INBOXSDK_DEV_PLACEHOLDER;
