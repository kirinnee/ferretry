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
 * The direct leg's commonest failure from another device is a loopback address. `127.0.0.1` means
 * "this computer itself", so on a phone it names the phone. The sentence says that in those words.
 *
 * This module names an ADDRESS'S HOST AND PORT only, never a path. A rendezvous path carries the
 * daemon fingerprint, and neither the code nor the fingerprint belongs in an error a reader may
 * paste into an issue.
 */

import { isLoopbackHost } from '@ferretry/protocol';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';

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

const directSentence = (leg: PairingLegFailure): string => {
  const host = hostOf(leg.address);
  const url = urlOf(leg.address);
  // The protocol owns what counts as loopback; this only asks it.
  if (url !== undefined && isLoopbackHost(url.hostname)) {
    return (
      `The pairing link gives the machine's address as ${host}. That address means "this computer itself", ` +
      'so on any other device it points back at that device and can never reach the machine.'
    );
  }
  return `This device could not reach the machine directly at ${host}. The machine may be asleep, or on a network this device cannot reach.`;
};

const relaySentence = (leg: PairingLegFailure): string => {
  const host = hostOf(leg.address);
  switch (leg.code) {
    case RELAY_CLOSE_CODES.daemonAbsent:
      return `Ferretry's relay (${host}) answered, but the machine is not connected to it right now. Check that Ferretry is running on the machine and that it is online.`;
    case RELAY_CLOSE_CODES.hostedDisabled:
      return `Ferretry's relay (${host}) is switched off right now, so there was nothing to fall back to.`;
    case RELAY_CLOSE_CODES.rendezvousBusy:
    case RELAY_CLOSE_CODES.hostedCapacity:
    case RELAY_CLOSE_CODES.hostedBandwidth:
      return `Ferretry's relay (${host}) is busy right now. Wait a minute and try again.`;
    case RELAY_CLOSE_CODES.heartbeatTimeout:
      return `Ferretry's relay (${host}) did not answer in time.`;
    default:
      return `Ferretry's relay (${host}) could not carry the connection either: it could not be reached, or it failed on its side.`;
  }
};

const NO_RELAY_SENTENCE =
  "There was no relay to fall back to: this page could not find out where Ferretry's relay is. Check this device's internet connection.";

/**
 * The sentence a pairing screen shows when every leg failed at transport.
 *
 * Each leg gets one sentence, in the order it was tried. A walk with no relay leg says so too,
 * because "the relay was never tried" and "the relay failed" have different remedies.
 */
export const describePairingUnreachable = (legs: readonly PairingLegFailure[]): string => {
  const sentences = legs.map(leg => (leg.kind === 'direct' ? directSentence(leg) : relaySentence(leg)));
  if (!legs.some(leg => leg.kind === 'relay')) sentences.push(NO_RELAY_SENTENCE);
  return sentences.join(' ');
};
