/** 43-byte transparent 1×1 GIF89a. */
export const TRANSPARENT_GIF: Uint8Array = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='),
  (ch) => ch.charCodeAt(0),
);

export const NO_STORE_HEADERS: Record<string, string> = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
  Pragma: 'no-cache',
  Expires: '0',
};
