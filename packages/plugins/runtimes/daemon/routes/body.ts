/**
 * Reading a request body against a schema. The schema is the boundary: a body that does not satisfy it never becomes
 * a domain value, and the caller is told which field was wrong instead of receiving a 500 from three layers down.
 *
 * GAP(kernel): the leaf carries `ApiRequest.text(limit)` but no body parser, so the parse every route shares is held
 * here, with today's error codes and sentences (`invalid_json`, `invalid_request`, `body_too_large`, `unreadable_body`).
 */
import { type ApiRequest, ApiError } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** How much of a body a route is willing to read; absent, the kernel's own ceiling applies. */
interface BodyLimits {
  readonly maxBytes?: number;
}

/**
 * The body, bounded, or the one refusal a client is ever told about it. The 413 names the daemon's own number and
 * nothing else: a refusal that quoted the submitted bytes would put caller content into a status line.
 */
async function readText(request: ApiRequest, limits: BodyLimits): Promise<string> {
  try {
    return await request.text(limits.maxBytes);
  } catch (error) {
    if (error instanceof Error && error.name === 'BodyTooLargeError')
      throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
}

function parseValue<Schema extends z.ZodType>(schema: Schema, value: unknown, where: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // The issue list names the failing paths without echoing the submitted values, so a rejected credential or
  // transcript fragment never comes back out in an error message.
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? where : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request ${where} is invalid — ${detail}`, 'invalid_request', result.error.issues);
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

/** Parses a request body against a schema. */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request, limits), 'body');
}

/**
 * Parses a body whose payload is entirely optional: an absent or whitespace-only body is the no-fields case, not a
 * client error. Malformed JSON is still rejected, because reading it as `{}` would drop a field the caller meant to send.
 */
export async function parseOptionalBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  const text = await readText(request, limits);
  return text.trim() === '' ? parseValue(schema, {}, 'body') : parseJson(schema, text, 'body');
}
