/**
 * HOW A BROWSER REACHES A PUBLISHER IT IS NOT PAIRED WITH, AS A CATALOG MEMBER — Connections' half of
 * `@ferretry/app`'s {@link MemberCarriers} (today's `relay-join.ts` and `member-client.ts` dial and drive).
 *
 * Connections provides ADDRESSING AND TRANSPORT and nothing that decides what is safe. The walk order, the deadlines it
 * is held to, the tunnel record, the device key and the session itself are fixed in `@ferretry/app` and built by
 * Catalogs over the seed's own fingerprint, so none of them can move in here. This module only:
 *  - names the one rendezvous this build discovered (the same advertisement every walk reads);
 *  - opens a socket for an address, naming the PUBLISHER's daemon id in the session route (a direct session socket is
 *    `/v1/rendezvous/<id>/client` on the publisher, and a relayed one is the same path on the rendezvous);
 *  - drives the session over it: the acceptance deadline, and — for a member session, which goes on to carry
 *    requests — the heartbeat that proves the carrier is alive (today's `driveRelaySession`).
 *
 * PAIRING IS NEVER RELAYED, and this is not pairing: a member session is opened with the member key a join registered,
 * so a publisher this browser holds no pairing for is reached only as the catalog member it joined as. Nothing here
 * widens what a member may do; it carries the sealed bytes.
 */
import { type MemberCarriers, type MemberSocket, RELAY_CLOSE_CODES, type RelayClientSession } from '@ferretry/app';
import { type BrowserSocket, createBrowserRelayDial } from '../adapters/browser-relay-dial.ts';
import {
  HEARTBEAT_LATE_TOLERANCE_MS,
  KEEPALIVE_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CHECK_DEADLINE_MS,
} from './carrier-socket.ts';
import { carrierSocketUrl } from './router.ts';

export interface MemberCarrierDependencies {
  readonly openSocket: (url: string) => BrowserSocket;
  readonly after: (delayMs: number, run: () => void) => void;
  readonly now: () => number;
  /** The one advertisement read this document performed (the hosted rendezvous), or `undefined`. */
  readonly hostedRelay: () => Promise<string | undefined>;
}

/** A cancellable one-shot over a timer that cannot be cancelled. */
const once = (after: MemberCarrierDependencies['after'], delayMs: number, run: () => void): (() => void) => {
  let live = true;
  after(delayMs, () => {
    if (!live) return;
    live = false;
    run();
  });
  return () => {
    live = false;
  };
};

export function memberCarriers(deps: MemberCarrierDependencies): MemberCarriers {
  const open = createBrowserRelayDial({ openSocket: deps.openSocket, after: deps.after });
  return {
    rendezvous: async () => await deps.hostedRelay(),

    dial(kind, address, daemonId): MemberSocket {
      const url = carrierSocketUrl(
        kind === 'direct' ? { kind: 'direct', daemonUrl: address } : { kind: 'relay', relayUrl: address },
        daemonId,
      );
      // A fingerprint no session can check is no address: nothing is opened, and the walk moves on.
      if (url === null) throw new Error('this daemon fingerprint cannot address a session');
      return open(url);
    },

    async drive<T>({
      socket,
      session,
      settled,
      keepAlive,
      deadlineMs,
    }: {
      readonly socket: MemberSocket;
      readonly session: RelayClientSession;
      readonly settled: Promise<T>;
      readonly keepAlive: boolean;
      readonly deadlineMs: number;
    }): Promise<T> {
      const cancels = new Set<() => void>();
      const stop = (): void => {
        for (const cancel of cancels) cancel();
        cancels.clear();
      };
      // The one unanswered ping, if any. ANY inbound message is the evidence of life, so a deadline that fires has, by
      // construction, heard nothing since it was armed.
      let pong: { readonly within: number; readonly cancel: () => void } | undefined;
      let forgiven = false;
      const armDeadline = (withinMs: number): void => {
        // A shorter wait replaces a longer one; a longer one never relaxes a shorter one already armed.
        if (pong !== undefined && pong.within <= withinMs) return;
        if (pong !== undefined) {
          pong.cancel();
          cancels.delete(pong.cancel);
        }
        const armedAt = deps.now();
        const cancel = once(deps.after, withinMs, () => {
          cancels.delete(cancel);
          pong = undefined;
          // Fired long after its time: the page was frozen or throttled, so this silence is the browser's, not the
          // carrier's. Ask again once on a running page (HEARTBEAT_LATE_TOLERANCE_MS).
          if (!forgiven && deps.now() - armedAt - withinMs > HEARTBEAT_LATE_TOLERANCE_MS) {
            forgiven = true;
            ping(LIVENESS_CHECK_DEADLINE_MS);
            return;
          }
          stop();
          session.carrierClosed(
            RELAY_CLOSE_CODES.heartbeatTimeout,
            `the carrier showed no sign of life for ${String(withinMs / 1_000)} s after a heartbeat`,
          );
          socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no heartbeat');
        });
        cancels.add(cancel);
        pong = { within: withinMs, cancel };
      };
      const ping = (withinMs: number): void => {
        session.heartbeat();
        armDeadline(withinMs);
      };
      const alive = (): void => {
        forgiven = false;
        if (pong === undefined) return;
        pong.cancel();
        cancels.delete(pong.cancel);
        pong = undefined;
      };
      let interval: (() => void) | undefined;
      const schedule = (): void => {
        if (interval !== undefined) cancels.delete(interval);
        interval = once(deps.after, KEEPALIVE_INTERVAL_MS, () => {
          ping(KEEPALIVE_DEADLINE_MS);
          schedule();
        });
        cancels.add(interval);
      };
      // A carrier that neither answers nor closes is a refusal, not a wait: the session must be accepted in time.
      const deadline = once(deps.after, deadlineMs, () => {
        stop();
        session.carrierClosed(RELAY_CLOSE_CODES.heartbeatTimeout, 'the rendezvous did not open a session in time');
        socket.close(RELAY_CLOSE_CODES.heartbeatTimeout, 'no session');
      });
      cancels.add(deadline);
      socket.onOpen = () => {
        if (keepAlive) schedule();
      };
      socket.onText = text => {
        alive();
        session.receiveText(text);
      };
      socket.onBinary = bytes => {
        alive();
        void session.receiveBinary(bytes);
      };
      socket.onClose = (code, reason) => {
        stop();
        session.carrierClosed(code, reason);
      };
      try {
        const value = await settled;
        if (!keepAlive) {
          stop();
          return value;
        }
        // The deadline covered getting here and nothing after it; the heartbeat covers the rest.
        deadline();
        cancels.delete(deadline);
        return value;
      } catch (reason) {
        stop();
        throw reason;
      }
    },
  };
}
