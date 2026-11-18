import type { Log } from '../../contract/ports.ts';

/**
 * WHAT THE DAEMON SAYS ABOUT A SESSION IT TURNED AWAY.
 *
 * The peer is told one uniform sentence; the daemon's own log keeps the reason, so an owner can say WHICH door was
 * shut. A line names the carrier and the id the credential CLAIMED: an identifier, never a key, a proof or a token.
 */

/** One `warn` for a session refused before it was live. */
export function refused(log: Log | undefined, carrier: string, why: string, holder?: string): void {
  log?.warn(`a session was refused: ${why}`, {
    carrier,
    ...(holder === undefined ? {} : { holder: holder.slice(0, 80) }),
  });
}

/** What a holder proof's body says the caller claimed to be, when it says it as a string. Total. */
export function claimedHolder(proof: { readonly body?: unknown }): string | undefined {
  const claimed = (proof.body as { readonly deviceId?: unknown } | undefined)?.deviceId;
  return typeof claimed === 'string' ? claimed : undefined;
}

/** Which check said no to a holder proof: the sentence the log keeps. Pure and total. */
export function whyHolder(
  modeKey: 'device' | 'member',
  found: {
    readonly mode: unknown;
    readonly kind: string | undefined;
    readonly holder: unknown;
    readonly transcript: unknown;
  },
): string {
  if (found.mode === undefined || found.kind === undefined || found.kind === 'none') {
    return `the ${modeKey} mode is off or answers for no holder`;
  }
  if (found.holder === undefined) {
    return `no ${modeKey} holder answers for this credential (unknown, revoked, or idle too long)`;
  }
  if (found.transcript === undefined) return `the ${modeKey} session had no handshake transcript to sign`;
  return `the ${modeKey} signature did not verify against the holder's key`;
}

/** One `warn` for a renewal the holder's key did not sign. */
export function renewalUnsigned(log: Log | undefined, carrier: string, holder: string): void {
  refused(log, carrier, "a renewal was not signed by the holder's key", holder);
}

/** One `warn` for a session refused at open, before any credential was asked of it. */
export function atOpen(log: Log | undefined, carrier: string, code: number, reason: string): void {
  log?.warn(`a session was refused at open (${code}): ${reason}`, { carrier });
}
