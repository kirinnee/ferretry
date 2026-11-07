import type { Instant } from '@ferretry/std';

/** An ISO instant fixture, typed as the contract's `Instant` (the text itself is unchanged). */
export const at = (iso: string): Instant => iso as Instant;
