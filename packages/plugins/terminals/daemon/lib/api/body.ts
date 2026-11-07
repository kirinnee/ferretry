import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/**
 * Parsing a request body against a schema (today's `lib/api/body.ts`, the part the terminal routes use). The read is
 * bounded before the schema sees it; a refusal names the failing paths and never echoes the submitted values.
 */

/** The bound for a route whose payload is caller-supplied text (today's `MAX_TEXT_BODY_BYTES`). */
export const MAX_TEXT_BODY_BYTES = 512 * 1024;

/** Parses a body against a schema. */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  maxBytes: number = MAX_TEXT_BODY_BYTES,
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request, maxBytes), 'body');
}

/**
 * Parses a body whose payload is entirely optional: an absent or whitespace-only body is the no-fields case, not a
 * client error. Malformed JSON is still rejected.
 */
export async function parseOptionalBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  maxBytes: number = MAX_TEXT_BODY_BYTES,
): Promise<z.output<Schema>> {
  const text = await readText(request, maxBytes);
  return text.trim() === '' ? parseValue(schema, {}, 'body') : parseJson(schema, text, 'body');
}

async function readText(request: ApiRequest, maxBytes: number): Promise<string> {
  try {
    return await request.text(maxBytes);
  } catch (error) {
    if (error instanceof Error && error.name === 'BodyTooLargeError')
      throw new ApiError(413, error.message, 'body_too_large');
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
  // The issue list names the failing paths without echoing the submitted values.
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? where : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request ${where} is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
