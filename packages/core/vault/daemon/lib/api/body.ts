import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/**
 * Parsing a request body against a schema (today's `lib/api/body.ts` `parseBody`, copied for the secret routes).
 *
 * The read is bounded before the schema sees it; a refusal names the failing paths and never echoes the submitted
 * values, so a rejected credential never comes back out in an error message.
 */

/** Decoded bytes in the largest single payload any API request legitimately carries — one attachment (today's value). */
const LARGEST_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** What base64 costs: four characters per three bytes, rounded up to the padded quantum. */
const ENCODED_PAYLOAD_BYTES = Math.ceil(LARGEST_PAYLOAD_BYTES / 3) * 4;

/** Room around the payload for the JSON envelope. */
const ENVELOPE_BYTES = 4 * 1024 * 1024;

/**
 * The bound the secret routes read under — today's `MAX_REQUEST_BODY_BYTES`, copied unchanged.
 *
 * Today every secret route (the import bundle above all) parsed under this default, and a valid bundle of many
 * secrets runs well past half a mebibyte, so a tighter bound here would refuse imports today accepts.
 */
export const MAX_REQUEST_BODY_BYTES = ENCODED_PAYLOAD_BYTES + ENVELOPE_BYTES;

export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
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
