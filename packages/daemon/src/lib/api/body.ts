import type { z } from 'zod';
import { ApiError } from './error.ts';
import type { ApiRequest } from './http.ts';

/**
 * Parses a request body against a schema.
 *
 * The source read `await request.json() as T` on every route: a syntactic cast that made the type
 * annotation a comment and let any shape at all reach the domain. Here the schema is the boundary —
 * a body that does not satisfy it never becomes a domain value, and the caller is told which field
 * was wrong instead of receiving a 500 from three layers down.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request), 'body');
}

/**
 * Parses a body whose payload is entirely optional: an absent or whitespace-only body is the
 * no-fields case, not a client error. Malformed JSON is still rejected — silently downgrading it to
 * `{}` would drop a field the caller meant to send.
 */
export async function parseOptionalBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  const text = await readText(request);
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

async function readText(request: ApiRequest): Promise<string> {
  try {
    return await request.text();
  } catch {
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
  throw new ApiError(400, `the request ${where} is invalid — ${detail}`, 'invalid_request');
}
