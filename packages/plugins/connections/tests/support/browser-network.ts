/**
 * A BROWSER'S NETWORK, scripted per host, in front of the REAL kernel session layer (`kernel-session.ts`).
 *
 * Connections' app half dials through `ports.openSocket`; this answers each URL by its host: a daemon (or a
 * rendezvous carrying to it) opens a real kernel link on the named carrier and speaks the rendezvous `ready` first,
 * exactly as the direct mount and the relay do; a dead host closes without opening; a silent one never answers; an
 * absent one opens and closes with a code. Every byte the browser sent is kept per host, so a test can prove what a
 * wrong rendezvous learned.
 */
import { type CarrierKey, isSessionEnd } from '@ferretry/kernel/contract';
import type { BrowserSocket } from '../../app/adapters/browser-relay-dial.ts';
import {
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  SESSION_ID_BYTES,
  type SessionId,
  sessionIdFromBytes,
} from '../../worker/src/lib/index.ts';
import { type KernelFixture, kernelCrypto } from './kernel-session.ts';

export type ScriptedHost =
  | { readonly kind: 'carries'; readonly carrier: 'direct' | 'relay' | 'tunnel'; readonly dropAfterFrames?: number }
  | { readonly kind: 'dead' }
  | { readonly kind: 'silent' }
  | { readonly kind: 'absent'; readonly code: number };

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export class BrowserNetwork {
  /** Every URL dialled, in order. */
  readonly dialled: string[] = [];
  /** Every binary frame the browser sent, per host. */
  readonly sent = new Map<string, Uint8Array[]>();

  constructor(
    private readonly fx: KernelFixture,
    private readonly hosts: Readonly<Record<string, ScriptedHost>>,
  ) {}

  /** The sealed record frames (`data`, everything past the handshake) a host received. */
  records(host: string): readonly Uint8Array[] {
    return (this.sent.get(host) ?? []).filter(bytes => bytes[2] === FRAME_KINDS.data);
  }

  openSocket = (url: string): BrowserSocket => {
    this.dialled.push(url);
    const host = new URL(url).host;
    const script = this.hosts[host] ?? { kind: 'dead' };
    if (!this.sent.has(host)) this.sent.set(host, []);
    let closed = false;
    let link: ReturnType<KernelFixture['layer']['open']> | undefined;
    const socket: BrowserSocket = {
      binaryType: 'blob',
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: data => {
        if (closed || typeof data === 'string') return;
        const bytes = new Uint8Array(data);
        this.sent.set(host, [...(this.sent.get(host) ?? []), bytes]);
        link?.inbound(bytes);
        if (script.kind === 'carries' && script.dropAfterFrames !== undefined) {
          const count = this.sent.get(host)?.length ?? 0;
          if (count >= script.dropAfterFrames) end(1006, '');
        }
      },
      close: (code, reason) => end(code ?? 1000, reason ?? ''),
    };
    const deliver = (bytes: Uint8Array): void => {
      if (!closed) socket.onmessage?.({ data: bytes.slice().buffer });
    };
    const end = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      link?.closed('the socket closed');
      void tick().then(() => socket.onclose?.({ code, reason }));
    };
    void tick().then(() => {
      if (closed) return;
      if (script.kind === 'dead') {
        end(1006, '');
        return;
      }
      if (script.kind === 'silent') return;
      socket.onopen?.();
      if (script.kind === 'absent') {
        end(script.code, 'no daemon holds this rendezvous');
        return;
      }
      const opened = this.fx.layer.open(script.carrier as CarrierKey, { address: '198.51.100.7' });
      link = opened;
      const pump = (): void => {
        for (let next = opened.outbound.next(); next !== undefined; next = opened.outbound.next()) {
          if (isSessionEnd(next)) {
            end(next.code, next.reason);
            return;
          }
          deliver(next.bytes);
        }
      };
      const sessionId = sessionIdFromBytes(kernelCrypto.randomBytes(SESSION_ID_BYTES)) as SessionId;
      deliver(
        encodeFrame({
          kind: FRAME_KINDS.control,
          sessionId,
          sequence: 0,
          payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
        }),
      );
      opened.outbound.onReady(pump);
      pump();
    });
    return socket;
  };
}

/** Timers a test fires by hand: a deadline that should not fire never does. */
export class HandTimers {
  readonly pending: { readonly ms: number; readonly run: () => void }[] = [];
  after = (ms: number, run: () => void): void => {
    this.pending.push({ ms, run });
  };
  /** Fires every timer armed for at least `ms` (the deadlines), once. */
  fire(ms: number): void {
    const due = this.pending.filter(timer => timer.ms >= ms);
    this.pending.splice(0, this.pending.length, ...this.pending.filter(timer => timer.ms < ms));
    for (const timer of due) timer.run();
  }
  /** Fires only the timers armed for exactly `ms` (one kind of deadline), once. */
  fireExactly(ms: number): void {
    const due = this.pending.filter(timer => timer.ms === ms);
    this.pending.splice(0, this.pending.length, ...this.pending.filter(timer => timer.ms !== ms));
    for (const timer of due) timer.run();
  }
}
