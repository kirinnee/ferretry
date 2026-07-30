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

export function jsonObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
