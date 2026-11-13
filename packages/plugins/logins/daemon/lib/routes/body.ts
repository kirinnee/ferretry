import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** The largest request body any login route accepts: a sign-in code, an address, a Test consent. */
const MAX_LOGIN_BODY_BYTES = 64 * 1024;

/**
 * Parses a request body against a schema (today's `parseBody`). The schema is the boundary: a body that does not
 * satisfy it never becomes a domain value, and the issue list names failing paths without echoing submitted values, so
 * a rejected code or address never comes back out in an error message.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(MAX_LOGIN_BODY_BYTES);
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
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request');
}
