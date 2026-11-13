/**
 * FIRST CONTACT WITH A DAEMON, ON EITHER CARRIER — today's `relay-pairing.ts` candidates and the carrier walk of
 * `exchangePairing` (PWA `lib/store.tsx`), as the {@link PairingCarriers} Connections hands the shell.
 *
 * Every redemption is a sealed `pair` record inside a session — over the daemon's own address first, then the one
 * rendezvous this build discovered. The session (the shell's) proves the daemon against the QR's fingerprint before
 * the code leaves this browser on every path, so a wrong directory or rendezvous learns none of it (P24, P135, R570).
 * Access mints the key the record registers and keeps it only once the daemon accepted it; this module only walks.
 *
 * WHAT THIS MODULE REFUSES TO DO:
 *
 * - **It will not dial a fingerprint it cannot verify.** A rendezvous is addressed by `fy_daemon_<43 base64url>` and
 *   the handshake is checked against that same string, so a link whose fingerprint is in any other spelling gets no
 *   carrier at all — not even the direct address.
 * - **It will not treat a refusal as a reason to try elsewhere.** A sealed `pair-refused` means the exchange HAPPENED
 *   and the answer is final for that attempt; carrying the same code to the next carrier would spend another attempt.
 * - **It will not dial an address that arrived in the link** beyond the daemon's own: the rendezvous it dials is the
 *   one its own build discovered (R580), so a composed URL cannot choose where a pre-auth socket opens.
 * - **PAIRING IGNORES THE CONNECTION PREFERENCE** (R633): WebRTC needs a device key to signal and a tunnel is
 *   published only to a paired device, so neither can be a pairing carrier.
 */
import {
  DaemonIdSchema,
  PairingOutcomeUnknownError,
  type PairedOver,
  type PairingAttempt,
  type PairingCarriers,
  type PairingLeg,
  type PairDirectInput,
  RelayPairingRefusedError,
  RelaySessionError,
} from '@ferretry/app';
import { type BrowserSocket, createBrowserRelayDial } from '../adapters/browser-relay-dial.ts';
import { DIRECT_SESSION_DEADLINE_MS } from '../carriers/carrier-socket.ts';
import { carrierSocketUrl } from '../carriers/router.ts';
import { ConnectionMethodSchema } from '../lib/connection.ts';
import { type PairingLegFailure, PairingUnreachableError } from './unreachable.ts';

/** How long the direct leg may take: a private address from cellular is dropped, not refused (today's value). */
const DIRECT_PAIRING_TIMEOUT_MS = DIRECT_SESSION_DEADLINE_MS;

/** One carrier first contact may cross. */
export interface PairingCandidate {
  readonly kind: 'direct' | 'relay';
  readonly address: string;
}

/**
 * Every carrier a redemption walks, in §1's order: the daemon's own address, then the one discovered rendezvous
 * (R582). A fingerprint this protocol cannot address gets nothing. The same list whatever a person chose (R633).
 */
export const pairingCandidates = (
  input: Pick<PairDirectInput, 'address' | 'daemonId'>,
  hostedRelayUrl: string | undefined,
): readonly PairingCandidate[] => {
  if (!DaemonIdSchema.safeParse(input.daemonId).success) return [];
  const discovered = discoveredRendezvous(hostedRelayUrl);
  return [{ kind: 'direct', address: input.address }, ...(discovered === undefined ? [] : [discovered])];
};

/** The advertisement's address, parsed by the protocol's own rule rather than trusted. */
const discoveredRendezvous = (hostedRelayUrl: string | undefined): PairingCandidate | undefined => {
  if (hostedRelayUrl === undefined) return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  return parsed.success && parsed.data.kind === 'relay' ? { kind: 'relay', address: parsed.data.relayUrl } : undefined;
};

/**
 * A sealed refusal that arrived after an earlier leg's code may already have been spent (P29). A subclass, so every
 * consumer that asks "refusal or transport failure" keeps getting `refusal`; what it adds is that minting again may
 * not be sufficient, because a device may already be paired under a grant nobody holds.
 */
export class AmbiguousPairingError extends RelayPairingRefusedError {
  constructor(refusal: unknown) {
    super();
    this.name = 'AmbiguousPairingError';
    this.cause = refusal;
    this.message =
      'this pairing code is spent, and an earlier attempt from this browser may be what spent it: the ' +
      'code reached the daemon, but the connection ended before its answer arrived, so the daemon may ' +
      'have paired a device this browser never heard about. Check the daemon for a device you do not ' +
      'recognise and revoke it, then run `fy pair` for a fresh code.';
  }
}

export interface PairingWalkDependencies {
  readonly openSocket: (url: string) => BrowserSocket;
  readonly after: (delayMs: number, run: () => void) => void;
  /** The one advertisement read this document performed. */
  readonly hostedRelay: () => Promise<string | undefined>;
  /** The direct leg's deadline; {@link DIRECT_PAIRING_TIMEOUT_MS} by default. */
  readonly directTimeoutMs?: number;
}

/**
 * The walk (today's `exchangePairing`, without the key, which is Access's). Only a TRANSPORT failure advances it; a
 * sealed refusal ends it on its own sentence, and a code that may have been spent unheard is reported as exactly that
 * (P29). When every leg failed, every leg is said in one plain sentence each (P30), naming host and port only (P31).
 */
export function pairingWalk(deps: PairingWalkDependencies): PairingCarriers {
  const dial = createBrowserRelayDial({ openSocket: deps.openSocket, after: deps.after });
  const leg = (input: PairDirectInput, candidate: PairingCandidate): PairingLeg | undefined => {
    const method =
      candidate.kind === 'direct'
        ? ({ kind: 'direct', daemonUrl: candidate.address } as const)
        : ({ kind: 'relay', relayUrl: candidate.address } as const);
    const url = carrierSocketUrl(method, input.daemonId);
    if (url === null) return undefined;
    return {
      kind: candidate.kind,
      address: candidate.address,
      dial: events => {
        const socket = dial(url);
        socket.onText = events.onText;
        socket.onBinary = events.onBinary;
        socket.onClose = events.onClose;
        return socket;
      },
      ...(candidate.kind === 'direct' ? { deadlineMs: deps.directTimeoutMs ?? DIRECT_PAIRING_TIMEOUT_MS } : {}),
    };
  };
  return {
    pair: async (input: PairDirectInput, attempt: PairingAttempt): Promise<PairedOver> => {
      const legs: PairingLegFailure[] = [];
      let spentUnheard: PairingOutcomeUnknownError | undefined;
      for (const candidate of pairingCandidates(input, await deps.hostedRelay())) {
        const one = leg(input, candidate);
        if (one === undefined) continue;
        try {
          const outcome = await attempt(one);
          return { ...outcome, via: { kind: candidate.kind, address: candidate.address } };
        } catch (reason) {
          // A sealed refusal is the DAEMON's answer and ends the walk; anything else is this carrier not working.
          if (reason instanceof RelayPairingRefusedError) {
            throw spentUnheard === undefined ? reason : new AmbiguousPairingError(reason);
          }
          if (reason instanceof PairingOutcomeUnknownError) spentUnheard ??= reason;
          const code =
            reason instanceof RelaySessionError
              ? reason.code
              : reason instanceof PairingOutcomeUnknownError && reason.cause instanceof RelaySessionError
                ? reason.cause.code
                : undefined;
          legs.push({ kind: candidate.kind, address: candidate.address, ...(code === undefined ? {} : { code }) });
        }
      }
      if (spentUnheard !== undefined) throw spentUnheard;
      if (legs.length === 0) throw new Error('no carrier could reach this daemon to pair with it');
      throw new PairingUnreachableError(legs);
    },
  };
}
