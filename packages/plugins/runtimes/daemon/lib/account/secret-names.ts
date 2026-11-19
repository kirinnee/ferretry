/**
 * How the import names the secrets it files in the Vault, in ONE place: the planner hands out `NAME`, then `NAME_2`, `NAME_3`, ...
 * and a retry that looks for the keys an earlier import filed must read the same family the planner wrote, or it misses them.
 */

/** The longest base a numbered name keeps, so `_<n>` still fits in the 64 characters a secret name may have. */
const BASE_KEPT = 60;

/** The `index`th name after `base` (`index` is 2 or more): a long base is shortened so the suffix fits. */
export const secretNameAt = (base: string, index: number): string => `${base.slice(0, BASE_KEPT)}_${String(index)}`;

/** Whether `held` is `stem` itself or one of the numbered names the planner would give it. */
export function inSecretFamily(stem: string, held: string): boolean {
  if (held === stem) return true;
  const prefix = `${stem.slice(0, BASE_KEPT)}_`;
  return held.startsWith(prefix) && /^\d+$/u.test(held.slice(prefix.length));
}
