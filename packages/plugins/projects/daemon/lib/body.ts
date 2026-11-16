/**
 * Request-body parsing for the registry routes (today's `daemon/src/lib/api/body.ts` `parseBody`, as Skills keeps it:
 * placement gives `api/` to Gate and no contract exports it yet). The kernel's `ApiRequest.text(limit)` bounds the read.
 */
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** A registration is a path, a name and a clone address: a few hundred bytes. Sixty-four KiB is generous. */
const MAX_BODY_BYTES = 64 * 1024;

const isBodyTooLarge = (error: unknown): error is Error => error instanceof Error && error.name === 'BodyTooLargeError';

export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(MAX_BODY_BYTES);
  } catch (error) {
    if (isBodyTooLarge(error)) throw new ApiError(413, error.message, 'body_too_large');
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
  // The issue list names the failing paths without echoing the submitted values.
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
