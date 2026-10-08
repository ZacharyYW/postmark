import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
/** 21-char URL-safe id (~126 bits). Used for message, pixel, link and reminder ids. */
export const newId = customAlphabet(ALPHABET, 21);

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashIp(ip: string, salt: string): string {
  return sha256Hex(`${salt}|${ip}`).slice(0, 32);
}

/** Short HMAC used for the optional `?s=` sender-view parameter on pixel/link URLs. */
export function signShort(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url').slice(0, 16);
}

export function verifyShort(secret: string, value: string, sig: string | undefined): boolean {
  if (!sig || sig.length !== 16) return false;
  const expected = Buffer.from(signShort(secret, value));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
