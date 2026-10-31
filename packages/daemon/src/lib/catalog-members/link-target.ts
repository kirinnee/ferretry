import type { Advertisement } from '@ferretry/protocol';
import type { ShareLinkTarget } from './ports.ts';

/**
 * Where a share link points. A share is for ANOTHER person's browser, so only an address a different device can
 * dial will do; the loopback answer pairing keeps for the owner's own phone-on-the-desk case is refused here,
 * because a link nobody else can open is a code spent for nothing. The refusal says what to set.
 */
export function shareLinkTarget(
  advertisement: Advertisement | undefined,
  daemonId: string | undefined,
  appOrigin: string,
): ShareLinkTarget {
  if (advertisement === undefined || daemonId === undefined)
    return { kind: 'unavailable', reason: 'This machine is still starting. Try again in a moment.' };
  if (advertisement.kind === 'address') return { kind: 'ready', appOrigin, daemonUrl: advertisement.url, daemonId };
  if (advertisement.kind === 'local-only')
    return {
      kind: 'unavailable',
      reason:
        'This machine only answers on its own loopback address, which no other person can open. Set a public address (publicUrl) so a share link has somewhere to point.',
    };
  return {
    kind: 'unavailable',
    reason:
      advertisement.refusal === 'no-port'
        ? 'This machine has no port to put in a link. Set a public address (publicUrl) or a port.'
        : 'This machine listens on every address and has no public address to put in a link. Set a public address (publicUrl) so a share link has somewhere to point.',
  };
}
