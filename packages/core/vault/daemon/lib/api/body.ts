import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/**
 * Parsing a request body against a schema (today's `lib/api/body.ts` `parseBody`, copied for the secret routes).
 *
 * The read is bounded before the schema sees it; a refusal names the failing paths and never echoes the submitted
 * values, so a rejected credential never comes back out in an error message.
 */

/** The body bound the secret routes read under: their largest body is one value of at most 16 KiB, plus a bundle. */
export const SECRET_BODY_BYTES = 512 * 1024;

export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  maxBytes: number = SECRET_BODY_BYTES,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(maxBytes);
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
