/**
 * Bounded, schema-parsed request bodies, copied from today's `packages/daemon/src/lib/api/body.ts` (bb89d054d).
 *
 * TODO(contract): the kernel's contract has `ApiRequest.text(limit)` but no `parseBody`; this is today's, so a body
 * that does not satisfy its schema never becomes a domain value and no refusal echoes a submitted value.
 */
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import type { z } from 'zod';

/** The largest body any route here takes: today's transport bound (one 32 MiB attachment, base64, plus room). */
const LARGEST_PAYLOAD_BYTES = 32 * 1024 * 1024;
const ENCODED_PAYLOAD_BYTES = Math.ceil(LARGEST_PAYLOAD_BYTES / 3) * 4;
const ENVELOPE_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = ENCODED_PAYLOAD_BYTES + ENVELOPE_BYTES;

interface BodyLimits {
  readonly maxBytes?: number;
}

/** Parses a request body against a schema, the read bounded before the schema sees it. */
export async function parseBody<Schema extends z.ZodType>(
  request: ApiRequest,
  schema: Schema,
  limits: BodyLimits = {},
): Promise<z.output<Schema>> {
  return parseJson(schema, await readText(request, limits), 'body');
}

/** A body whose payload is entirely optional: an absent or whitespace-only body is the no-fields case. */
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

/** The body, bounded, or the one refusal a client is ever told about it: never the submitted bytes. */
async function readText(request: ApiRequest, limits: BodyLimits): Promise<string> {
  try {
    return await request.text(limits.maxBytes ?? MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    // TODO(contract): the kernel's body-too-large error is not exported; today's is matched by its name.
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
