/**
 * HOW A BROWSER REACHES A PUBLISHER IT IS NOT PAIRED WITH, as a catalog member: join with a share link, ask what a join
 * needs, and open a member request session. The carriers (the publisher's own address, the relays it published, the
 * discovered rendezvous) are Connections' (§4.8), but only as ADDRESSING AND TRANSPORT: the walk order, the deadlines,
 * the tunnel record, the device key handle and the pinned session are fixed in `@ferretry/app` or built here, so a
 * Connections implementation cannot weaken them. A refusal is final; only a transport failure advances the walk.
 *
 * GAP(connections): the shell does not offer a member transport yet, so {@link noMemberTransport} answers every ask
 * as "unreachable" and no publisher is reached from this half. Nothing is sent, and the share code is never spent.
 * Connections' port must keep these guarantees, which are tested here against fake carriers: a leg whose dial throws
 * moves on; a refusal is final; spent-unheard is reported; 4403/401 mean the key is refused; a lease replay is a GET only;
 * a timeout closes the session. The walk-order cases (loopback, fingerprint, published relays, de-duplication) live in
 * `@ferretry/app` `memberWalk`; the direct and relay deadlines and the real socket/heartbeat behaviour are Connections'.
 */

import {
  DaemonCallError,
  memberCarriers,
  type MemberCarriers,
  type MemberPublisher,
  type MemberPurpose,
  type MemberSocket,
  type MemberStep,
  memberTunnelRequest,
  memberTunnelResponse,
  memberWalk,
  RELAY_CLOSE_CODES,
  RelayClientSession,
  type RelayClientSessionDependencies,
  RelayJoinRefusedError,
  RelaySessionError,
  toBase64Url,
  WebCryptoRelayCrypto,
} from '@ferretry/app';
import type { z } from 'zod';
import {
  type JoinProofOptions,
  JoinProofOptionsSchema,
  type MemberJoinedResponse,
  MemberJoinedResponseSchema,
  type MemberJoinProof,
  type ShareLinkSeed,
} from '../../contract/wire/index.ts';
import { type MemberClient, MemberRefusedError, MemberUnreachableError } from './member-client.ts';
import type { MemberSubscription, MintedMemberKeys } from './member-keys.ts';

/** The carrier a session crossed. */
export type MemberCarrierMethod =
  | { readonly kind: 'direct'; readonly daemonUrl: string }
  | { readonly kind: 'relay'; readonly relayUrl: string };

/** What the publisher said joining with this code needs. */
export type JoinOptionsAnswer =
  | { readonly kind: 'open'; readonly why: 'first-browser' | 'owner-approved' }
  | {
      readonly kind: 'challenge';
      readonly memberLabel: string;
      readonly options: JoinProofOptions;
    };

/** What walking every carrier to join came to. */
export type JoinResult =
  | { readonly kind: 'joined'; readonly response: MemberJoinedResponse; readonly carrier: MemberCarrierMethod }
  | { readonly kind: 'refused'; readonly maybeSpentUnheard: boolean }
  | { readonly kind: 'unreachable'; readonly maybeSpentUnheard: boolean; readonly tried: number };

/** What asking every carrier what a join needs came to. */
export type JoinOptionsResult =
  | { readonly kind: 'answer'; readonly answer: JoinOptionsAnswer; readonly carrier: MemberCarrierMethod }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unreachable' };

export interface MemberTransport {
  join(options: {
    readonly seed: ShareLinkSeed;
    readonly clientName: string;
    readonly keys: MintedMemberKeys;
    /** One of the person's passkeys signing the publisher's challenge; absent on a first join. */
    readonly passkey?: MemberJoinProof;
  }): Promise<JoinResult>;
  joinOptions(options: { readonly seed: ShareLinkSeed; readonly keys: MintedMemberKeys }): Promise<JoinOptionsResult>;
  openClient(subscription: MemberSubscription): Promise<MemberClient>;
}

/** The transport of a build the shell offers none to: every publisher is unreachable, and nothing is sent. */
export const noMemberTransport: MemberTransport = {
  join: () => Promise.resolve({ kind: 'unreachable', maybeSpentUnheard: false, tried: 0 }),
  joinOptions: () => Promise.resolve({ kind: 'unreachable' }),
  openClient: () => Promise.reject(new MemberUnreachableError(0)),
};

// ─── the transport over the shell's member carriers ──────────────────────────────────────────────────────────────

const MEMBER_REQUEST_TIMEOUT_MS = 30_000;

/** The persisted publisher address is ALWAYS the publisher's own, never the address of the step that reached it. */
const methodOf = (step: MemberStep, publisher: MemberPublisher): MemberCarrierMethod =>
  step.kind === 'direct'
    ? { kind: 'direct', daemonUrl: publisher.daemonUrl }
    : { kind: 'relay', relayUrl: step.address };

const publisherOf = (seed: Pick<ShareLinkSeed, 'daemonId' | 'daemonUrl'>): MemberPublisher => ({
  daemonId: seed.daemonId,
  daemonUrl: seed.daemonUrl,
});

/** The session a walk builds over a socket; replaced only by tests. */
export type MemberSessionFactory = (dependencies: RelayClientSessionDependencies) => RelayClientSession;

const walkOf = (carriers: MemberCarriers, publisher: MemberPublisher, purpose: MemberPurpose): readonly MemberStep[] =>
  memberWalk(publisher, purpose, { rendezvousUrl: carriers.rendezvousUrl });

/** The join, `join-options` and member session walks over `carriers` (today's `relay-join.ts` and `member-client.ts`). */
export function memberTransportOver(
  carriers: MemberCarriers,
  crypto: WebCryptoRelayCrypto,
  sessionOf: MemberSessionFactory = dependencies => new RelayClientSession(dependencies),
): MemberTransport {
  /** Dials a step and builds the session over its socket. THROWS when the carrier cannot address the publisher. */
  const open = (
    step: MemberStep,
    daemonId: string,
    mode: RelayClientSessionDependencies['mode'],
  ): { readonly socket: MemberSocket; readonly session: RelayClientSession } => {
    const socket = carriers.dial(step.kind, step.address);
    return { socket, session: sessionOf({ crypto, daemonId, mode, socket }) };
  };

  return {
    async join({ seed, clientName, keys, passkey }) {
      const publisher = publisherOf(seed);
      const steps = walkOf(carriers, publisher, 'join');
      const key = crypto.deviceKeyHandle(keys.signingKey);
      let spentUnheard = false;
      for (const step of steps) {
        let socket: MemberSocket | undefined;
        let session: RelayClientSession | undefined;
        try {
          ({ socket, session } = open(step, seed.daemonId, {
            kind: 'join',
            code: seed.code,
            clientName,
            memberKey: keys.publicKey,
            boxKey: keys.boxKey,
            key,
            ...(passkey === undefined ? {} : { passkey }),
          }));
          const outcome = await carriers.drive({
            kind: step.kind,
            socket,
            session,
            settled: session.joined(),
            keepAlive: false,
            deadlineMs: step.deadlineMs,
          });
          socket.close(1000, 'this join attempt is complete');
          return {
            kind: 'joined',
            response: MemberJoinedResponseSchema.parse(
              (outcome as Extract<typeof outcome, { kind: 'joined' }>).response,
            ),
            carrier: methodOf(step, publisher),
          };
        } catch (reason) {
          // A dial that threw opened nothing and sent nothing: the walk simply moves on.
          socket?.close(1000, 'this join attempt is over');
          if (reason instanceof RelayJoinRefusedError) return { kind: 'refused', maybeSpentUnheard: spentUnheard };
          // The `join` record crossed and the session ended before the answer: the share may have been spent unheard.
          if (session?.credentialSent() === true) spentUnheard = true;
        }
      }
      return { kind: 'unreachable', maybeSpentUnheard: spentUnheard, tried: steps.length };
    },

    async joinOptions({ seed, keys }) {
      const publisher = publisherOf(seed);
      const key = crypto.deviceKeyHandle(keys.signingKey);
      for (const step of walkOf(carriers, publisher, 'join')) {
        let socket: MemberSocket | undefined;
        try {
          let session: RelayClientSession;
          ({ socket, session } = open(step, seed.daemonId, {
            kind: 'join-options',
            code: seed.code,
            memberKey: keys.publicKey,
            origin: globalThis.location?.origin ?? '',
            key,
          }));
          const outcome = await carriers.drive({
            kind: step.kind,
            socket,
            session,
            settled: session.joined(),
            keepAlive: false,
            deadlineMs: step.deadlineMs,
          });
          socket.close(1000, 'this join-options attempt is complete');
          const answer: JoinOptionsAnswer =
            outcome.kind === 'challenge'
              ? {
                  kind: 'challenge',
                  memberLabel: outcome.memberLabel,
                  options: JoinProofOptionsSchema.parse(outcome.options),
                }
              : (outcome as JoinOptionsAnswer);
          return { kind: 'answer', answer, carrier: methodOf(step, publisher) };
        } catch (reason) {
          socket?.close(1000, 'this join-options attempt is over');
          if (reason instanceof RelayJoinRefusedError) return { kind: 'refused' };
        }
      }
      return { kind: 'unreachable' };
    },

    openClient(subscription) {
      return Promise.resolve(openMemberClientOver(carriers, crypto, subscription, sessionOf));
    },
  };
}

const keyGone = (error: DaemonCallError): boolean => error.status === 401 && error.code === 'unauthorized';

/** A member request session over `subscription`'s publisher. Opens nothing until the first request. */
function openMemberClientOver(
  carriers: MemberCarriers,
  crypto: WebCryptoRelayCrypto,
  subscription: MemberSubscription,
  sessionOf: MemberSessionFactory,
): MemberClient {
  const key = crypto.deviceKeyHandle(subscription.signingKey);
  const appSession = toBase64Url(crypto.randomBytes(APP_SESSION_BYTES));
  let current: Promise<RelayClientSession> | undefined;
  let closed = false;

  const walk = async (): Promise<RelayClientSession> => {
    const steps = walkOf(carriers, subscription, 'member');
    for (const step of steps) {
      let socket: MemberSocket | undefined;
      try {
        socket = carriers.dial(step.kind, step.address);
        const session = sessionOf({
          crypto,
          daemonId: subscription.daemonId,
          mode: { kind: 'member', member: { keyId: subscription.keyId, key, appSession } },
          socket,
        });
        return await carriers.drive({
          kind: step.kind,
          socket,
          session,
          settled: session.ready(),
          keepAlive: true,
          deadlineMs: step.deadlineMs,
        });
      } catch (reason) {
        // A dial that threw opened nothing: the walk moves on. A rejected key is final.
        socket?.close(1000, 'this member session attempt is over');
        if (reason instanceof RelaySessionError && reason.code === AUTH_REJECTED) throw new MemberRefusedError();
      }
    }
    throw new MemberUnreachableError(steps.length);
  };

  const session = async (): Promise<RelayClientSession> => {
    if (closed) throw new MemberUnreachableError(0);
    const found = current === undefined ? undefined : await current;
    if (found?.live() === true) return found;
    const opening = walk();
    current = opening;
    try {
      return await opening;
    } catch (reason) {
      if (current === opening) current = undefined;
      throw reason;
    }
  };

  const send = async (path: string, init: RequestInit, carrying: RelayClientSession): Promise<Response> => {
    const record = memberTunnelRequest(new URL(path, subscription.daemonUrl).toString(), init);
    const signal = AbortSignal.timeout(MEMBER_REQUEST_TIMEOUT_MS);
    try {
      return memberTunnelResponse(await carrying.request(record, signal));
    } catch (reason) {
      if (signal.aborted) carrying.close('the publisher did not answer a request in time');
      if (reason instanceof RelaySessionError && reason.code === AUTH_REJECTED) throw new MemberRefusedError();
      throw reason;
    }
  };

  return {
    async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
      let carrying = await session();
      let response: Response;
      try {
        response = await send(path, init, carrying);
      } catch (reason) {
        // A lease that ran out is not a failure: a read is simply asked again on a fresh session.
        const expired =
          reason instanceof RelaySessionError &&
          reason.code === LEASE_ENDED &&
          (init.method ?? 'GET').toUpperCase() === 'GET';
        if (!expired) throw reason;
        carrying = await session();
        response = await send(path, init, carrying);
      }
      if (!response.ok) {
        const error = await errorOf(response);
        if (keyGone(error)) throw new MemberRefusedError();
        throw error;
      }
      if (response.status === 204) return schema.parse(undefined);
      return schema.parse(await response.json());
    },
    close(): void {
      closed = true;
      const opened = current;
      current = undefined;
      void opened?.then(
        live => {
          live.close('the member left this publisher');
        },
        () => undefined,
      );
    },
  };
}

/** The member transport the shell offers, or {@link noMemberTransport} (fail closed) when it offers none. */
export function currentMemberTransport(
  crypto: () => WebCryptoRelayCrypto = () => new WebCryptoRelayCrypto(),
): MemberTransport {
  const carriers = memberCarriers();
  return carriers === undefined ? noMemberTransport : memberTransportOver(carriers, crypto());
}

/** The close the publisher answers an unknown member key with, and the one a ended access lease ends a session with. */
const AUTH_REJECTED = RELAY_CLOSE_CODES.authRejected;
const LEASE_ENDED = 4441;
/** Bytes of the per-tab app-session id a member session names itself with. */
const APP_SESSION_BYTES = 16;

/** The publisher's own refusal as the shell's one error; its `{ error, code }` body says what went wrong. */
const errorOf = async (response: Response): Promise<DaemonCallError> => {
  let candidate: unknown;
  try {
    candidate = await response.json();
  } catch {
    candidate = undefined;
  }
  const body = (typeof candidate === 'object' && candidate !== null ? candidate : {}) as {
    error?: unknown;
    code?: unknown;
  };
  const message = typeof body.error === 'string' ? body.error : `the publisher answered ${String(response.status)}`;
  return new DaemonCallError(response.status, typeof body.code === 'string' ? body.code : '', message, candidate);
};
