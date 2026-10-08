/** 43-byte transparent 1×1 GIF89a. */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
  'base64',
);

export const NO_STORE_HEADERS: Record<string, string> = {
  'Content-Type': 'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
  Pragma: 'no-cache',
  Expires: '0',
};
