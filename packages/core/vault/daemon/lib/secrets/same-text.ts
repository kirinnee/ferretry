import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Whether two texts are equal, decided without leaking where they differ or how long either is: both are reduced to a
 * fixed-length digest first and the digests are compared in constant time. The digests exist only inside this call and
 * are never returned, logged or stored; the answer is one bit.
 */
export function sameText(left: string, right: string): boolean {
  const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}
