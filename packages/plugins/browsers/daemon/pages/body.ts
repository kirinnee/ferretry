import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** Today's `MAX_TEXT_BODY_BYTES`: no browser route takes an upload, so a JSON body is bounded small. */
const MAX_BROWSER_BODY_BYTES = 512 * 1024;

/**
 * Today's `parseBody` (`api/body.ts`), for the browser routes: the body, bounded, parsed against `schema`. The
 * refusals name the failing paths and never echo a submitted value.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
): Promise<z.output<Schema>> {
  let text: string;
  try {
    text = await request.text(MAX_BROWSER_BODY_BYTES);
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
  return parseValue(schema, parsed, 'body');
}

/** Parses an already-decoded value (a tool's input), refusing in the same words. */
export function parseValue<Schema extends z.ZodType>(schema: Schema, value: unknown, where: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map(issue => `${issue.path.join('.') === '' ? where : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new ApiError(400, `the request ${where} is invalid — ${detail}`, 'invalid_request', result.error.issues);
}
