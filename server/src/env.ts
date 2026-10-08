import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  /** Public base URL used to build pixel and link URLs (no trailing slash). */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  DATABASE_PATH: z.string().default('./data/postmark.db'),
  /** Comma-separated extension ids allowed for CORS (chrome-extension://<id>). Empty = any extension origin (dev only). */
  EXTENSION_IDS: z.string().default(''),
  /** Trust X-Forwarded-For (only when behind a reverse proxy you control). */
  TRUST_PROXY: bool,
  /** Dev-only: allow re-registering an existing email to rotate its token. */
  DEV_ALLOW_TOKEN_ROTATION: bool,
  /** Comma-separated CIDRs treated as Apple Mail Privacy Protection egress. */
  APPLE_MPP_CIDRS: z.string().default('17.0.0.0/8'),
  /** Optional fixed salt for IP hashing; otherwise a random per-install salt is stored in the DB. */
  IP_HASH_SALT: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['silent', 'error', 'info', 'debug']).default('info'),
});

export type Env = z.infer<typeof EnvSchema> & {
  TRUST_PROXY: boolean;
  DEV_ALLOW_TOKEN_ROTATION: boolean;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.parse(source);
  return {
    ...parsed,
    PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    TRUST_PROXY: parsed.TRUST_PROXY ?? false,
    DEV_ALLOW_TOKEN_ROTATION: parsed.DEV_ALLOW_TOKEN_ROTATION ?? false,
  };
}
