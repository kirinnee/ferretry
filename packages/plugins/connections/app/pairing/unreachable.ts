/**
 * WHY NO CARRIER COULD PAIR, ONE PLAIN SENTENCE PER LEG.
 *
 * A pairing walk tries the daemon's own address and then the relay this build discovered. When
 * both fail, the reader needs to know what happened on EACH, because the two have different
 * remedies. Reporting only the first failure showed a phone on cellular "could not open a socket
 * to ws://127.0.0.1:‹port› … nothing reached the relay protocol … a rendezvous serving this daemon":
 * relay vocabulary for a direct dial, and silence about the relay leg, which was the leg that
 * mattered (it was failing on the relay's side).
 *
 * A loopback direct address (`127.0.0.1`) is NORMAL for the one supported way to pair a machine you reach over
 * SSH: a tunnel from this computer. It is therefore one clause in the direct sentence and the first fix to try,
 * never the verdict. Pairing can cross the relay (protocol §14), so a relay leg that failed is said as a failure
 * to carry the pairing, not as a fallback that was never possible.
 *
 * This module names an ADDRESS'S HOST AND PORT only, never a path. A rendezvous path carries the
 * daemon fingerprint, and neither the code nor the fingerprint belongs in an error a reader may
 * paste into an issue.
 */

import { RELAY_CLOSE_CODES } from '@ferretry/app';
import { isLoopbackHost } from '../../contract/index.ts';

/** One carrier that was tried and did not carry the exchange. */
export interface PairingLegFailure {
  readonly kind: 'direct' | 'relay';
  /** The carrier's base address: the daemon URL, or the relay origin. */
  readonly address: string;
  /** The WebSocket or session close code the attempt ended with, when it had one. */
  readonly code?: number;
}

/** Every carrier failed at transport. The code never reached the daemon, so it is probably still good. */
export class PairingUnreachableError extends Error {
  constructor(readonly legs: readonly PairingLegFailure[]) {
    super(describePairingUnreachable(legs));
    this.name = 'PairingUnreachableError';
  }
}

/** The parsed address, or undefined when it is not a URL. */
const urlOf = (address: string): URL | undefined => {
  try {
    return new URL(address);
  } catch {
    return undefined;
  }
};

/** `host:port` for an address, or the input itself when it is not a URL. Never a path. */
const hostOf = (address: string): string => urlOf(address)?.host ?? address;

/** The protocol owns what counts as loopback; this only asks it. */
const isLoopbackDirect = (leg: PairingLegFailure): boolean => {
  const url = urlOf(leg.address);
  return url !== undefined && isLoopbackHost(url.hostname);
};

const directSentence = (leg: PairingLegFailure): string => {
  const host = hostOf(leg.address);
  // A loopback address is NORMAL here: through an SSH tunnel it is the supported way in. So it is one clause, never the verdict.
  const why = isLoopbackDirect(leg)
    ? `${urlOf(leg.address)?.hostname ?? host} only works on that machine itself, or through an SSH tunnel from this computer.`
    : 'The machine may be asleep, or on a network this device cannot reach.';
  return `First, directly at ${host}: no answer. ${why}`;
};

const relaySentence = (leg: PairingLegFailure): string => {
  const host = hostOf(leg.address);
  switch (leg.code) {
    case RELAY_CLOSE_CODES.daemonAbsent:
      // Pairing CAN cross the relay (protocol §14), so this says why it did not: the machine is not on it.
      return `Ferretry's relay (${host}) answered, but the machine is not connected to it, so it could not carry the pairing.`;
    case RELAY_CLOSE_CODES.hostedDisabled:
      return `Ferretry's relay (${host}) is switched off right now, so there was nothing to fall back to.`;
    case RELAY_CLOSE_CODES.hostedCapacity:
      // Not "busy": a full connection count is the relay's own bookkeeping, and on 2026-10-19 it was a
      // count that leaked and never came down, so "wait a minute" sent the owner round in circles.
      return (
        `Ferretry's relay (${host}) refused the connection because its connection limit for this machine, or for the relay as a whole, is full. ` +
        "That is a count the relay keeps, not the machine being busy. If this machine does not have many devices connected, the relay's count is wrong; " +
        'it repairs that by itself within about ten minutes, and the machine reconnects by itself too, so try again then.'
      );
    case RELAY_CLOSE_CODES.hostedBandwidth:
      // Not "busy": a data allowance comes back at a fixed time, and "wait a minute" is wrong for a day.
      return `Ferretry's relay (${host}) refused the connection because a relay data allowance is used up; a daily one resets at midnight UTC. Direct connections still work.`;
    case RELAY_CLOSE_CODES.rendezvousBusy:
      return `Ferretry's relay (${host}) is busy right now. Wait a minute and try again.`;
    case RELAY_CLOSE_CODES.heartbeatTimeout:
      return `Ferretry's relay (${host}) did not answer in time.`;
    default:
      return `Ferretry's relay (${host}) could not carry the connection either: it could not be reached, or it failed on its side.`;
  }
};

const NO_RELAY_SENTENCE =
  "There was no relay to fall back to: this page could not find out where Ferretry's relay is. Check this device's internet connection.";

/** The heading line of the fix list; the screen reads it and the numbered lines under it as a list. */
const MOST_LIKELY_FIX = 'Most likely fix:';

/**
 * The fixes worth trying, most likely first, for the legs that actually failed.
 *
 * The browser knows only what each carrier answered, never the machine's own settings (the link carries no relay
 * state), so the relay item says "may be switched off", never that it is.
 */
const fixesFor = (legs: readonly PairingLegFailure[]): readonly string[] => {
  const direct = legs.find(leg => leg.kind === 'direct');
  const relay = legs.find(leg => leg.kind === 'relay');
  const fixes: string[] = [];
  if (direct !== undefined && isLoopbackDirect(direct)) {
    fixes.push(
      'If you use an SSH tunnel: check it is still running, and that its local port was free (look for "Could not request local forwarding" in the ssh window).',
      'Open the link in the same browser, on the same computer as the tunnel.',
    );
  } else {
    fixes.push('Check the machine is awake and on a network this device can reach.');
  }
  fixes.push('If Chrome asked about local network access, allow it.');
  if (relay?.code === RELAY_CLOSE_CODES.daemonAbsent) {
    fixes.push(
      'Ferretry may not be running on that machine, or its relay may be switched off there. Pairing from another device needs it running with the relay on (or an SSH tunnel).',
    );
  }
  return fixes;
};

/**
 * The text a pairing screen shows when every leg failed at transport.
 *
 * Line by line: what was tried, in the order it was tried (one short sentence per leg, and one more when there was no
 * relay leg, because "never tried" and "failed" have different remedies), then {@link MOST_LIKELY_FIX} and a numbered
 * list. The pairing screen renders the numbered lines as a list; any other reader gets plain lines.
 */
const describePairingUnreachable = (legs: readonly PairingLegFailure[]): string => {
  const tried = legs.map(leg => (leg.kind === 'direct' ? directSentence(leg) : `Then ${relaySentence(leg)}`));
  if (!legs.some(leg => leg.kind === 'relay')) tried.push(NO_RELAY_SENTENCE);
  const fixes = fixesFor(legs).map((fix, index) => `${index + 1}. ${fix}`);
  return [...tried, MOST_LIKELY_FIX, ...fixes].join('\n');
};
