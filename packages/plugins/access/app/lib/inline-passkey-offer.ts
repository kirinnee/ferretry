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
