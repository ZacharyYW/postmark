import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType, ZodTypeDef } from 'zod';
import type { UserRow } from './db/repo';

export type AppEnv = {
  Variables: {
    user: UserRow;
    ipHash: string;
  };
};

export class ApiHttpError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(status, { message });
  }
}

export function parseOr400<O, I = O>(schema: ZodType<O, ZodTypeDef, I>, data: unknown): O {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiHttpError(
      400,
      'VALIDATION',
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  return r.data;
}

export async function jsonBody(c: Context): Promise<unknown> {
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > 256 * 1024) throw new ApiHttpError(413, 'TOO_LARGE', 'Request body too large');
  try {
    return await c.req.json();
  } catch {
    throw new ApiHttpError(400, 'BAD_JSON', 'Body must be valid JSON');
  }
}

export const notFound = (what = 'Resource') =>
  new ApiHttpError(404, 'NOT_FOUND', `${what} not found`);
