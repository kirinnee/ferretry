/** One direct socket carries one Kernel session. Sealing and proof stay in the Kernel. */
import {
  isSessionEnd,
  type CarrierKey,
  type CarrierLink,
  type SessionLayer,
  type SocketDownstream,
  type SocketEnded,
  type SocketFrame,
  type SocketHandler,
} from '@ferretry/kernel/contract';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  SESSION_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  SESSION_ID_BYTES,
  sessionIdFromBytes,
  type SessionId,
} from '@ferretry/kernel/wire';
import { encodeControlMessage, RELAY_LIMITS } from './control.ts';
import type { OpenCarrierSession, RelayLinkScheduler } from './session-ports.ts';

export const MAX_DIRECT_SESSIONS = 64;
export const MAX_DIRECT_UNPROVEN_SESSIONS = 16;
export const DIRECT_UPGRADES_PER_PEER = 30;
export const MAX_DIRECT_UNPROVEN_PER_PEER = 2;
export const EVICTED_REASON = 'too many sessions are awaiting a credential';
export const DIRECT_UPGRADE_WINDOW_MS = 60_000;
export interface DirectCarrierDependencies {
  readonly identity: { readonly daemonId: string };
  readonly scheduler: RelayLinkScheduler;
  readonly clock: { now(): number };
  readonly randomBytes: (length: number) => Uint8Array;
  readonly sessions: () => SessionLayer;
  readonly openSession: OpenCarrierSession;
}
function frameBytes(frame: SocketFrame): Uint8Array | null {
  if (typeof frame === 'string') return null;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}
export class DirectSession implements SocketHandler {
  readonly #sessionId: SessionId;
  #link: CarrierLink | undefined;
  #stop: (() => void) | undefined;
  #ended = false;
  #draining = false;
  constructor(
    private readonly deps: DirectCarrierDependencies,
    private readonly peer: string | undefined,
    private readonly downstream: SocketDownstream,
    private readonly release: () => void,
    private readonly onProved: () => void = () => undefined,
  ) {
    const id = sessionIdFromBytes(deps.randomBytes(SESSION_ID_BYTES));
    if (id === null) throw new Error('the session identifier generator produced an unusable identifier');
    this.#sessionId = id;
  }
  get sessionId(): SessionId {
    return this.#sessionId;
  }
  async open(): Promise<void> {
    if (this.#ended) return;
    this.downstream.send(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      }),
    );
    this.#link = this.deps.openSession(
      this.deps.sessions(),
      'direct' as CarrierKey,
      this.peer === undefined ? {} : { address: this.peer },
      this.onProved,
    );
    this.#stop = this.#link.outbound.onReady(() => this.#drain());
    this.#drain();
  }
  fromClient(frame: SocketFrame): void {
    if (this.#ended) return;
    if (frame === HEARTBEAT_REQUEST) {
      this.downstream.send(HEARTBEAT_RESPONSE);
      return;
    }
    if (frame === HEARTBEAT_RESPONSE) return;
    const bytes = frameBytes(frame);
    const decoded = bytes === null ? undefined : decodeFrame(bytes);
    if (bytes === null || decoded === undefined || !decoded.ok) {
      this.#end(SESSION_CLOSE_CODES.protocolError, 'unparseable frame');
      return;
    }
    if (decoded.frame.kind === FRAME_KINDS.control) {
      this.#end(SESSION_CLOSE_CODES.protocolError, 'a client may not speak for the rendezvous on a direct socket');
      return;
    }
    if (decoded.frame.sessionId.text !== this.#sessionId.text) {
      this.#end(SESSION_CLOSE_CODES.protocolError, 'a frame named no live session');
      return;
    }
    this.#link?.inbound(bytes);
  }
  #drain(): void {
    if (this.#draining || this.#ended || this.#link === undefined) return;
    this.#draining = true;
    try {
      while (!this.#ended) {
        const next = this.#link.outbound.next();
        if (next === undefined) break;
        if (isSessionEnd(next)) {
          this.downstream.send(
            encodeFrame({
              kind: FRAME_KINDS.control,
              sessionId: this.#sessionId,
              sequence: 0,
              payload: encodeControlMessage({ t: 'closed', code: next.code, reason: next.reason }),
            }),
          );
          this.#end(next.code, next.reason);
          break;
        }
        // The final permit is inside next(); this socket write must be synchronous.
        this.downstream.send(next.bytes);
      }
    } catch {
      this.#end(SESSION_CLOSE_CODES.relayInternal, 'the daemon could not carry this frame');
    } finally {
      this.#draining = false;
    }
  }
  close(ended?: SocketEnded): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#stop?.();
    this.#link?.closed(ended?.reason ?? 'the daemon released this socket');
    this.release();
  }
  evict(): void {
    this.#end(SESSION_CLOSE_CODES.rendezvousBusy, EVICTED_REASON);
  }
  #end(code: number, reason: string): void {
    if (this.#ended) return;
    this.close({ code, reason });
    this.downstream.close(code, truncateUtf8(reason, 123));
  }
}
function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) return text;
  let out = '';
  for (const character of text) {
    if (encoder.encode(out + character).byteLength > limit) break;
    out += character;
  }
  return out;
}
