import { z } from 'zod';

const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

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
