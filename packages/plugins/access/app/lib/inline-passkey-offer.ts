/**
 * WHILE A SCREEN OFFERS "ADD A PASSKEY NOW" IN PLACE, NO PROMPT POPS OVER IT (A555 r7).
 *
 * Right after pairing, the success screen offers the first passkey inline (`first-passkey-offer.tsx`). The machine just
 * paired with also answered the app's first reads `401 unlock_required`, and — the press on "Pair this device" still
 * fresh — the unlock gate raised its own "Add a passkey to this device" modal over the card: the same offer twice, one
 * of them unasked. So the card HOLDS its machine while it shows, and Access's gates raise nothing for that machine from
 * a request nobody pressed for until it lets go; a press (`explicit`) still asks at once.
 *
 * One count per machine: two cards for one machine release independently. Holds nothing secret.
 */

import type { DaemonConnection } from '../shell-grants.ts';

const held = new Map<string, number>();
const listeners = new Set<() => void>();

const told = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Holds this machine while the card shows; returns the one function that lets go (idempotent). */
export function holdInlinePasskeyOffer(daemonId: string): () => void {
  held.set(daemonId, (held.get(daemonId) ?? 0) + 1);
  told();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(daemonId) ?? 1) - 1;
    if (left <= 0) held.delete(daemonId);
    else held.set(daemonId, left);
    told();
  };
}

/** Whether a card is offering this machine's first passkey in place right now. */
export const inlinePasskeyOffered = (daemonId: string): boolean => held.has(daemonId);

/** Told whenever a card starts or stops holding a machine. */
export function onInlinePasskeyOffer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * THE UNLOCK THAT FOLLOWS "PASSKEY ADDED", ON THE SAME CARD (S-11).
 *
 * A registration is never an unlock (the daemon's rule, `docs/design/zero-trust.md`), so a machine that unlocks on opening
 * still wants one touch after the first passkey is added. That used to arrive as a second modal over a card that had just
 * said "Passkey added", which reads as the passkey loop. The shell hands the card this instead: the card keeps holding its
 * machine, says the unlock is the next step, and runs it from its own button through the unlock gate (so every request
 * waiting on the machine is answered). Nothing here holds a credential.
 */
interface InlineUnlock {
  /** Whether this machine will ask this device to unlock on opening; a read that fails says yes (the unlock is harmless). */
  readonly needed: (connection: DaemonConnection) => Promise<boolean>;
  /** Runs the unlock ceremony; resolves to the sentence to show when it did not finish, or nothing when it did. */
  readonly run: (connection: DaemonConnection) => Promise<string | undefined>;
}

let inlineUnlock: InlineUnlock | undefined;

/** Registers the shell's unlock for cards; returns the function that withdraws it. */
export function provideInlineUnlock(provider: InlineUnlock): () => void {
  inlineUnlock = provider;
  return () => {
    if (inlineUnlock === provider) inlineUnlock = undefined;
  };
}

/** The shell's unlock for a card, or nothing when no shell is mounted (a bare page draws no unlock step). */
export const currentInlineUnlock = (): InlineUnlock | undefined => inlineUnlock;
