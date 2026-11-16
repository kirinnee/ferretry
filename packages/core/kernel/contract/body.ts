import type { z } from 'zod';
import { ApiError, type ApiRequest } from './http.ts';

/**
 * Today's `packages/daemon/src/lib/api/body.ts`, copied: a request body (or query) parsed against a schema, the read
 * BOUNDED before the schema sees it, and the refusals byte for byte (`413 body_too_large`, `400 unreadable_body`,
 * `400 invalid_json`, `400 invalid_request` with the failing paths and never the submitted values). Halves call it in
 * their handlers, as today's routes did; the dispatcher does not parse bodies.
 */

/**
 * Decoded bytes in the largest single payload any API request legitimately carries — one attachment.
 *
 * Stated here rather than imported from the attachment domain, because this is the TRANSPORT's
 * answer and it must not shift every time a subsystem retunes its own ceiling.
 */
const LARGEST_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** What base64 costs: four characters per three bytes, rounded up to the padded quantum. Attachments
 *  travel inline as base64 inside JSON, so the wire is always larger than the payload. */
const ENCODED_PAYLOAD_BYTES = Math.ceil(LARGEST_PAYLOAD_BYTES / 3) * 4;

/** Room around the payload: the JSON envelope, up to sixteen filenames and mime types, and the
 *  opening message a start describes its attachments in. */
const ENVELOPE_BYTES = 4 * 1024 * 1024;

/**
 * The largest request body this daemon will accept, in bytes — enforced by the runtime BEFORE the
 * daemon holds the bytes (the listener's `maxRequestBodySize`), and the default bound for every parsed body.
 *
 * Sized from the largest VALID request rather than picked: one 32 MiB attachment, base64-encoded,
 * inside a JSON envelope. A route that carries bulk caller-supplied text rather than an attachment should
 * not inherit this: pass `maxBytes` and bound it near its own contract.
 */
export const MAX_REQUEST_BODY_BYTES = ENCODED_PAYLOAD_BYTES + ENVELOPE_BYTES;

/**
 * The bound for a route whose payload is bulk caller-supplied TEXT rather than an attachment: pass
 * `{ maxBytes: MAX_TEXT_BODY_BYTES }`.
 */
export const MAX_TEXT_BODY_BYTES = 512 * 1024;

/**
 * What `request.text(limit)` throws when the body is over `limit`, on every arrival (the local listener and a
 * sealed session alike). An `ApiError`, so a handler that reads the body itself still answers today's 413.
 */
export class BodyTooLargeError extends ApiError {
  constructor(readonly limitBytes: number) {
    super(413, `the request body is over the ${limitBytes}-byte limit`, 'body_too_large');
    this.name = 'BodyTooLargeError';
  }
}

/** How much of a body a route is willing to read. */
export interface BodyLimits {
  readonly maxBytes?: number;
}

/** Parses a request body against a schema; a body that does not satisfy it never becomes a domain value. */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request, limits), 'body');
}

/**
 * Parses a body whose payload is entirely optional: an absent or whitespace-only body is the
 * no-fields case, not a client error. Malformed JSON is still rejected. Optional is not unbounded.
 */
export async function parseOptionalBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  const text = await readText(request, limits);
  return text.trim() === '' ? parseValue(schema, {}, 'body') : parseJson(schema, text, 'body');
}

/** Parses query parameters against a schema, taking the first value given for each key. */
export function parseQuery<Schema extends z.ZodType>(request: ApiRequest, schema: Schema): z.output<Schema> {
  const single: Record<string, string> = {};
  for (const [key, values] of request.query) {
    const first = values[0];
    if (first !== undefined) single[key] = first;
  }
  return parseValue(schema, single, 'query');
}

/**
 * The body, bounded, or the one refusal a client is ever told about it. The 413 names the daemon's own number and
 * nothing else.
 */
async function readText(request: ApiRequest, limits: BodyLimits): Promise<string> {
  const limit = limits.maxBytes ?? MAX_REQUEST_BODY_BYTES;
  try {
    return await request.text(limit);
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) throw new BodyTooLargeError(limit);
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
}

function parseJson<Schema extends z.ZodType>(schema: Schema, text: string, where: string): z.output<Schema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, `the request ${where} is not valid JSON`, 'invalid_json');
  }
  return parseValue(schema, parsed, where);
}

function parseValue<Schema extends z.ZodType>(schema: Schema, value: unknown, where: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // The issue list names the failing paths without echoing the submitted values, so a rejected
  // credential or transcript fragment never comes back out in an error message.
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? where : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request ${where} is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
