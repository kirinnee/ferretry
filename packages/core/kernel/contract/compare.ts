/**
 * Today's `secretsMatch` (`packages/daemon/src/lib/api/authentication.ts`), copied: compares two strings in time that
 * depends only on the longer length, never on where they first differ. It walks the longer of the two every time and
 * folds the length disagreement into the same accumulator. The length itself is not hidden — a token's length is not
 * the secret, its content is.
 */
export function secretsMatch(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // charCodeAt is NaN past the end; `| 0` makes the out-of-range side a stable 0 so the loop
    // never short-circuits on the shorter string.
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0);
  }
  return difference === 0;
}
