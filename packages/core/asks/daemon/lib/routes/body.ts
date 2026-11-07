import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/**
 * Parses a request body against a schema (today's `parseBody`): an empty body is `{}`. The schema is the boundary: a
 * body that does not satisfy it never becomes a domain value. The kernel bounds the read and answers `413` itself.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  if (text.trim() === '') return parseValue(schema, {});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  return parseValue(schema, parsed);
}

function parseValue<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // The issue list names the failing paths without echoing the submitted values, so a refused answer never comes
  // back out in an error message.
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request body is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
