/**
 * Parses a request body against a schema (today's `api/body.ts`, copied). The schema is the boundary: a body that
 * does not satisfy it never becomes a domain value, and the caller is told which field was wrong. The issue list
 * names the failing paths without echoing the submitted values, so a rejected password never comes back out.
 */
import { type ApiRequest, ApiError } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** The bound every Accounts body is read under: no account write carries more than a few kilobytes. */
const MAX_BODY_BYTES = 512 * 1024;

export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(MAX_BODY_BYTES);
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
  throw new ApiError(
    400,
    `the request body is invalid — ${detail}`,
    'invalid_request',
    result.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
  );
}
