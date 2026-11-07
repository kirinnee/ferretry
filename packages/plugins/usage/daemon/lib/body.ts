import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** The most a request body to this plugin may be: a rate catalog edit or a sync selection, far under this. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * A request body parsed against its schema. The read is bounded first; a refusal names the failing paths and never echoes
 * what was submitted.
 */
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
  throw new ApiError(400, `the request body is invalid: ${detail}`, 'invalid_request', result.error.issues);
}
