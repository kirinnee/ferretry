import { z } from 'zod';

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export type JsonDocumentResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly message: string };

export function parseJsonDocument(text: string): JsonDocumentResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, message: 'invalid JSON' };
  }
  const parsed = JsonValueSchema.safeParse(decoded);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: 'value is not JSON serializable' };
}
export function canonicalJsonValue(value: unknown): JsonValue {
  return JsonValueSchema.parse(value);
}

export function serializeJsonDocument(value: unknown): string {
  const parsed = canonicalJsonValue(value);
  const encoded = JSON.stringify(parsed, null, 2);
  if (encoded === undefined) throw new TypeError('value is not JSON serializable');
  return `${encoded}\n`;
}

export function jsonObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined;
/** A frozen document's object, still frozen all the way down. */
export function jsonObject(value: FrozenJsonValue | undefined): Readonly<Record<string, FrozenJsonValue>> | undefined;
export function jsonObject(value: FrozenJsonValue | undefined): Readonly<Record<string, FrozenJsonValue>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, FrozenJsonValue>>)
    : undefined;
}

/**
 * A JSON value nobody may change: what storage hands out for a session document it has cached. Every
 * reader is given the SAME instance, so a write through it would change what every other reader sees.
 */
export type FrozenJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly FrozenJsonValue[]
  | { readonly [key: string]: FrozenJsonValue };

/** Freezes a parsed JSON value all the way down, in place, and answers it. */
export function deepFreezeJson(value: JsonValue): FrozenJsonValue {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child as JsonValue);
    Object.freeze(value);
  }
  return value;
}
