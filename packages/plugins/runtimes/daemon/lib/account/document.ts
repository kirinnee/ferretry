/**
 * Names for the building blocks a configuration is made of.
 *
 * Pure.
 */

const NAME_LIMIT = 64;

/** The nearest letters-digits-dashes name to `value`, or `fallback` when nothing of it survives. */
export function slugName(value: string, fallback: string): string {
  const slug = value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, NAME_LIMIT)
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? fallback : slug;
}
