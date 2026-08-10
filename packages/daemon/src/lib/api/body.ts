import type { z } from 'zod';
import { ApiError } from './error.ts';
import { type ApiRequest, BodyTooLargeError } from './http.ts';

/**
 * Decoded bytes in the largest single payload any API request legitimately carries — one attachment.
 *
 * Stated here rather than imported from the attachment domain, because this is the TRANSPORT's
 * answer and it must not shift every time a subsystem retunes its own ceiling. A unit test holds the
 * two numbers against each other, so raising the attachment limit fails loudly instead of quietly
 * making valid uploads unservable.
 */
const LARGEST_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** What base64 costs: four characters per three bytes, rounded up to the padded quantum. Attachments
 *  travel inline as base64 inside JSON, so the wire is always larger than the payload. */
const ENCODED_PAYLOAD_BYTES = Math.ceil(LARGEST_PAYLOAD_BYTES / 3) * 4;

/** Room around the payload: the JSON envelope, up to sixteen filenames and mime types, and the
 *  opening message a start describes its attachments in. Four mebibytes of prose is far more than a
 *  caller has ever sent and still a rounding error against the payload itself. */
const ENVELOPE_BYTES = 4 * 1024 * 1024;

/**
 * The largest request body this daemon will accept, in bytes — enforced by the runtime BEFORE the
 * daemon holds the bytes, and the default bound for every parsed body.
 *
 * Sized from the largest VALID request rather than picked: one 32 MiB attachment, base64-encoded,
 * inside a JSON envelope. Bun's own default is 128 MiB, which is not a bound anyone chose — it is
 * four times the largest thing this API has a use for, and every byte of it is heap an authenticated
 * caller can make the daemon reserve before a single schema has looked at the request.
 *
 * A route that carries bulk caller-supplied text rather than an attachment should not inherit this:
 * pass `maxBytes` and bound it near its own contract — a fleet proposal's asset edits, for one, are
 * bounded at 256 KiB by the time they are parsed, and the read that precedes them should say so.
 */
export const MAX_REQUEST_BODY_BYTES = ENCODED_PAYLOAD_BYTES + ENVELOPE_BYTES;

/**
 * The bound for a route whose payload is bulk caller-supplied TEXT rather than an attachment.
 *
 * Sized on the largest such route: a fleet proposal's asset edits are bounded at 256 KiB across at
 * most 32 files by the time they are parsed, and the read that precedes them has no business being
 * a hundred times more generous. Twice the contract leaves room for the JSON envelope, the escaping
 * every quote and newline in a configuration file costs, and the mutation the edits travel with.
 *
 * Stated here, once, so the route that adopts it inherits the reasoning rather than a number: pass
 * `{ maxBytes: MAX_TEXT_BODY_BYTES }`.
 */
export const MAX_TEXT_BODY_BYTES = 512 * 1024;

/** How much of a body a route is willing to read. Injected rather than assumed, for the reason every
 *  limit in this daemon is: a test that had to allocate the shipped ceiling to prove the refusal
 *  would be measuring the machine it runs on. */
interface BodyLimits {
  readonly maxBytes?: number;
}

/**
 * Parses a request body against a schema.
 *
 * The source read `await request.json() as T` on every route: a syntactic cast that made the type
 * annotation a comment and let any shape at all reach the domain. Here the schema is the boundary —
 * a body that does not satisfy it never becomes a domain value, and the caller is told which field
 * was wrong instead of receiving a 500 from three layers down.
 *
 * The read is BOUNDED before the schema sees it. Every bound a schema states — an asset edit's
 * 256 KiB, an attachment's 32 MiB — is otherwise enforced against a string the transport has already
 * materialised, which is the wrong end of the allocation to be standing at.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request, limits), 'body');
}

/**
 * Parses a body whose payload is entirely optional: an absent or whitespace-only body is the
 * no-fields case, not a client error. Malformed JSON is still rejected — silently downgrading it to
 * `{}` would drop a field the caller meant to send.
 *
 * Optional is not unbounded: a route that needs no body at all still refuses an oversized one, so
 * `POST` with nothing to say cannot be turned into an upload.
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
 * The body, bounded, or the one refusal a client is ever told about it.
 *
 * The 413 names the daemon's own number and nothing else. A refusal that quoted the submitted bytes
 * back — or the field it stopped at — would put caller content into a status line for the one class
 * of request most likely to be carrying something private.
 */
async function readText(request: ApiRequest, limits: BodyLimits): Promise<string> {
  try {
    return await request.text(limits.maxBytes ?? MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ApiError(413, error.message, 'body_too_large');
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
