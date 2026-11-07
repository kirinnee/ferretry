/**
 * Request-body parsing for Lessons' routes (today's `daemon/src/lib/api/body.ts`, `parseBody`). Placement gives `api/` to
 * Gate; until a contract exports it, each plugin keeps this copy. The kernel's `ApiRequest.text(limit)` bounds the read.
 */
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** The kernel's over-limit error is named `BodyTooLargeError` (its class is not exported). */
const isBodyTooLarge = (error: unknown): error is Error => error instanceof Error && error.name === 'BodyTooLargeError';

/**
 * The largest request body this daemon will accept: one 32 MiB attachment, base64-encoded, inside a JSON envelope. A
 * lesson's body is a sentence, so Lessons passes a far smaller bound of its own.
 */
const LESSON_BODY_BYTES = 64 * 1024;

/**
 * Parses a request body against a schema. The read is BOUNDED before the schema sees it, and a body that does not satisfy
 * the schema never becomes a domain value: the caller is told which field was wrong instead of receiving a 500 from three
 * layers down.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request));
}

/**
 * The body, bounded, or the one refusal a client is ever told about it. The 413 names the daemon's own number and nothing
 * else: a refusal that quoted the submitted bytes back would put caller content into a status line.
 */
async function readText(request: ApiRequest): Promise<string> {
  try {
    return await request.text(LESSON_BODY_BYTES);
  } catch (error) {
    if (isBodyTooLarge(error)) throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
}

function parseJson<Schema extends z.ZodType>(schema: Schema, text: string): z.output<Schema> {
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
