/**
 * A REQUEST CLIENT FOR ONE PUBLISHER, AS A CATALOG MEMBER.
 *
 * A member session is a request session on the member route table (`/v1/shared/*`) and nothing else
 * (docs/relay-protocol.md §14 "Member sessions"). This client opens one on the first request, over the
 * same walk a pairing makes: the publisher's own address, then whatever relays it published, then the
 * rendezvous this build discovered. It keeps the session for the next request and opens a fresh one when
 * the last is gone. It answers the shape the catalog surfaces already take, `request(path, schema, init)`.
 *
 * TWO REFUSALS ARE TOLD APART FROM EVERYTHING ELSE, because a person must never be left guessing:
 *
 * - `MemberRefusedError`: the publisher refused this KEY (`4403` on a new session, `401 unauthorized` on an
 *   open one). Nothing here deletes anything on it; the caller marks the subscription and asks the person.
 * - `MemberUnreachableError`: no carrier reached the publisher. The key may be perfectly good.
 *
 * Every other answer is the publisher's own, as an `FyHttpError` whose `code` is the top-level `code` of
 * its `{ error, code }` body (`member_locked`, `member_registration_closed`, `share_other_member`, …).
 */

import { ApiErrorResponseSchema, RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  APP_SESSION_BYTES,
  connectionSocketUrl,
  type PrivateKeyHandle,
  RELAY_CLOSE_CODES,
  toBase64Url,
} from '@ferretry/relay';
import type { z } from 'zod';
import type { MemberSubscription } from './member-keys.ts';
import {
  browserHeartbeat,
  browserRelayDial,
  driveRelaySession,
  type RelayDial,
  type RelayHeartbeatSchedule,
  relayResponse,
  relayTunnelRequest,
} from './relay-carrier.ts';
import { DIRECT_JOIN_TIMEOUT_MS, type MemberCarrierMethod, memberCandidates } from './relay-join.ts';
import { RelayClientSession, type RelayClientSessionDependencies, RelaySessionError } from './relay-session.ts';

/** The publisher refused this browser's key. Final: another carrier would be told the same. */
export class MemberRefusedError extends Error {
  constructor() {
    super('the publisher no longer accepts this browser');
    this.name = 'MemberRefusedError';
  }
}

/** No carrier reached the publisher. Says nothing about the key. */
export class MemberUnreachableError extends Error {
  constructor(readonly tried: number) {
    super('no way of reaching the publisher answered');
    this.name = 'MemberUnreachableError';
  }
}

/** How long one request may wait for its answer before the session is dropped and the person told. */
const MEMBER_REQUEST_TIMEOUT_MS = 30_000;

export interface MemberClientOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'] & {
    deviceKeyHandle(key: CryptoKey): PrivateKeyHandle;
    randomBytes(length: number): Uint8Array;
  };
  readonly subscription: Pick<MemberSubscription, 'daemonId' | 'daemonUrl' | 'carriers' | 'keyId' | 'signingKey'>;
  readonly hostedRelayUrl: string | undefined;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  readonly directTimeoutMs?: number;
  readonly relayTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/** What a member surface calls. `request` has the catalog surfaces' shape; `close` ends the session. */
export interface MemberClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
  close(): void;
}

const errorOf = async (response: Response): Promise<FyHttpError> => {
  let candidate: unknown;
  try {
    candidate = await response.json();
  } catch {
    candidate = undefined;
  }
  const parsed = ApiErrorResponseSchema.safeParse(candidate);
  const payload = parsed.success ? parsed.data : undefined;
  const message = payload?.error ?? `the publisher answered ${String(response.status)}`;
  return new FyHttpError(message, response.status, payload?.code, candidate);
};

/** Whether this answer means the publisher no longer knows this key. */
const keyGone = (error: FyHttpError): boolean => error.status === 401 && error.code === 'unauthorized';

/** A member client over `options.subscription`'s publisher. Opens nothing until the first request. */
export const openMemberClient = (options: MemberClientOptions): MemberClient => {
  const dial = options.dial ?? browserRelayDial;
  const heartbeat = options.heartbeat ?? browserHeartbeat;
  const key = options.crypto.deviceKeyHandle(options.subscription.signingKey);
  const appSession = toBase64Url(options.crypto.randomBytes(APP_SESSION_BYTES));
  let current: Promise<RelayClientSession> | undefined;
  let closed = false;

  const attempt = async (method: MemberCarrierMethod, url: string): Promise<RelayClientSession> => {
    const socket = dial(url);
    const session = new RelayClientSession({
      crypto: options.crypto,
      daemonId: options.subscription.daemonId,
      mode: { kind: 'member', member: { keyId: options.subscription.keyId, key, appSession } },
      socket,
    });
    const deadlineMs =
      method.kind === 'direct' ? (options.directTimeoutMs ?? DIRECT_JOIN_TIMEOUT_MS) : options.relayTimeoutMs;
    try {
      return await driveRelaySession({
        socket,
        session,
        heartbeat,
        settled: session.ready(),
        keepAlive: true,
        ...(deadlineMs === undefined ? {} : { deadlineMs }),
      });
    } catch (reason) {
      socket.close(1000, 'this member session attempt is over');
      throw reason;
    }
  };

  const walk = async (): Promise<RelayClientSession> => {
    const candidates = memberCandidates(options.subscription, options.hostedRelayUrl).flatMap(method => {
      const url = connectionSocketUrl(method, options.subscription.daemonId, 'client');
      return url === null ? [] : [{ method, url }];
    });
    for (const { method, url } of candidates) {
      try {
        return await attempt(method, url);
      } catch (reason) {
        if (reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.authRejected) {
          throw new MemberRefusedError();
        }
      }
    }
    throw new MemberUnreachableError(candidates.length);
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
    const record = relayTunnelRequest(new URL(path, options.subscription.daemonUrl).toString(), init);
    const signal = AbortSignal.timeout(options.requestTimeoutMs ?? MEMBER_REQUEST_TIMEOUT_MS);
    try {
      return relayResponse(await carrying.request(record, signal));
    } catch (reason) {
      if (signal.aborted) carrying.close('the publisher did not answer a request in time');
      if (reason instanceof RelaySessionError && reason.code === RELAY_CLOSE_CODES.authRejected) {
        throw new MemberRefusedError();
      }
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
          reason.code === RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE &&
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
        open => {
          open.close('the member left this publisher');
        },
        () => undefined,
      );
    },
  };
};
