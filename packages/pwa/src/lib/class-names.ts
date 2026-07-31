/**
 * Class-name composition for the shell components.
 *
 * kteam's UI reached for `clsx`. The bundle here is a public, static Cloudflare
 * Pages artifact, so a 40-line total function that the 100% ledger can prove is
 * a better trade than a dependency, and the accepted shapes are identical.
 */

export type ClassValue = string | number | bigint | null | undefined | boolean | ClassValue[] | ClassDictionary;

export interface ClassDictionary {
  readonly [key: string]: unknown;
}

const appendTo = (parts: string[], value: ClassValue): void => {
  if (value === null || value === undefined || value === false || value === true || value === '') return;

  if (typeof value === 'string') {
    parts.push(value);
    return;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    // `0` is a real class name in Tailwind-adjacent code the same way `1` is,
    // so numbers are kept rather than treated as falsy.
    parts.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) appendTo(parts, entry);
    return;
  }

  for (const [key, enabled] of Object.entries(value)) {
    if (enabled) parts.push(key);
  }
};

/** Joins every truthy class expression with a single space. */
export function cn(...values: readonly ClassValue[]): string {
  const parts: string[] = [];
  for (const value of values) appendTo(parts, value);
  return parts.join(' ');
}
