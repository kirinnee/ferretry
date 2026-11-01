/**
 * The owner card for a 2FA seed a ferret or `fy` staged (`twoFactorSeed` on an agenda item): what it says and when
 * Allow may be pressed. Every sentence is the daemon's (the item's subject, why and context) or the app's own; the
 * seed is never here, only the stage's id.
 */

import { TWO_FACTOR_SEED_CARD_MISMATCH_LINE } from '@ferretry/protocol';

export interface SeedCardFacts {
  /** The daemon's lines about the key, without its bullet and without the mismatch line. */
  readonly lines: readonly string[];
  /** The key was staged with "save it here anyway": the card draws the amber box and asks for the second tick. */
  readonly mismatch: boolean;
}

const BULLET = /^\s*[-*]\s+/;

/** `flagged` is the daemon's structured mismatch flag; the sentence it also writes is only a second way to know. */
export const seedCardFacts = (context: string | undefined, flagged = false): SeedCardFacts => {
  const all = (context ?? '')
    .split('\n')
    .map(line => line.replace(BULLET, '').trim())
    .filter(line => line !== '');
  return {
    lines: all.filter(line => line !== TWO_FACTOR_SEED_CARD_MISMATCH_LINE),
    mismatch: flagged || all.includes(TWO_FACTOR_SEED_CARD_MISMATCH_LINE),
  };
};

/** Why Allow is not pressable, in words, or `undefined` when it is. */
export const seedAllowBlocked = (gate: {
  readonly mismatch: boolean;
  readonly warningTick: boolean;
  readonly mismatchTick: boolean;
}): string | undefined => {
  if (!gate.warningTick) return 'Tick the box about the two factors first.';
  if (gate.mismatch && !gate.mismatchTick) return 'Tick “Save it here anyway”, or Deny.';
  return undefined;
};

/** Whether the daemon has said if this key was staged as a mismatch: until a read succeeds, Allow stays off. */
export type SeedCheck = 'checking' | 'ok' | 'failed';

export const SEED_UNCHECKED_WORDS = 'Could not check this key. Try again.';

export const SEED_DENIED_WORDS = 'Denied. Nothing was saved and the key is gone.';
export const SEED_GONE_WORDS =
  'This save is no longer waiting: it was saved, denied or timed out. If you still expect it, confirm it from a paired device.';
