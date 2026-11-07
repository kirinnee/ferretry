import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/**
 * What the Conversation routes share (today's `lib/api/body.ts` `parseBody` and `lib/api/responses.ts` `namesTag`).
 *
 * The body read is bounded before the schema sees it; a refusal names the failing paths and never echoes the submitted
 * values.
 */

/** Decoded bytes in the largest single payload any request legitimately carries: one attachment (today's value). */
const LARGEST_PAYLOAD_BYTES = 32 * 1024 * 1024;
const ENCODED_PAYLOAD_BYTES = Math.ceil(LARGEST_PAYLOAD_BYTES / 3) * 4;
const ENVELOPE_BYTES = 4 * 1024 * 1024;

/** Today's `MAX_REQUEST_BODY_BYTES`: one base64 attachment and its envelope. */
const MAX_REQUEST_BODY_BYTES = ENCODED_PAYLOAD_BYTES + ENVELOPE_BYTES;

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

/** Whether `If-None-Match` names this tag. GET compares weakly (RFC 9110 §13.1.2), so `W/` is ignored. */
export function namesTag(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map(candidate => candidate.trim())
    .some(candidate => candidate === '*' || candidate.replace(/^W\//u, '') === etag);
}
