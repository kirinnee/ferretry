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
import type { DirectSessionLog } from '../tunnel/session-log.ts';
import type { OpenCarrierSession, RelayLinkScheduler } from './session-ports.ts';

/** The carrier whose sessions are reported to the daemon's log (§15, "What the daemon logs"). */
const TUNNEL_CARRIER = 'tunnel' as CarrierKey;

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
  /**
   * Where a TUNNEL session's life is reported (`docs/relay-protocol.md` §15, "What the daemon logs"). Absent means
   * nothing is logged. Only a session that arrived on the tunnel carrier is reported: a tab on the host opening and
   * closing sessions all day is not news, and a phone behind Cloudflare dropping one is what an owner asks about.
   */
  readonly sessionLog?: DirectSessionLog;
}
function frameBytes(frame: SocketFrame): Uint8Array | null {
  if (typeof frame === 'string') return null;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}
export class DirectSession implements SocketHandler {
  readonly #sessionId: SessionId;
  readonly #onProved: () => void;
  #link: CarrierLink | undefined;
  #stop: (() => void) | undefined;
  #ended = false;
  #draining = false;
  /** Where this session's life is reported — only for a tunnel arrival — and what is reported. */
  readonly #log: DirectSessionLog | undefined;
  readonly #openedAt: number;
  #lastFrameAt: number;
  #bytesIn = 0;
  #bytesOut = 0;
  #proved = false;
  /** Set when THIS daemon ended the socket, before the transport reports the close back. */
  #endedHere: { readonly code: number; readonly reason: string } | undefined;
  constructor(
    private readonly deps: DirectCarrierDependencies,
    /** The carrier the ARRIVAL names: the kernel session opens on it, so a tunnel socket is never a direct session. */
    private readonly carrier: CarrierKey,
    private readonly peer: string | undefined,
    private readonly downstream: SocketDownstream,
    private readonly release: () => void,
    onProved: () => void = () => undefined,
  ) {
    const id = sessionIdFromBytes(deps.randomBytes(SESSION_ID_BYTES));
    if (id === null) throw new Error('the session identifier generator produced an unusable identifier');
    this.#sessionId = id;
    this.#log = carrier === TUNNEL_CARRIER ? deps.sessionLog : undefined;
    this.#openedAt = deps.clock.now();
    this.#lastFrameAt = this.#openedAt;
    this.#onProved = () => {
      this.#proved = true;
      onProved();
    };
  }
  get sessionId(): SessionId {
    return this.#sessionId;
  }
  async open(): Promise<void> {
    if (this.#ended) return;
    this.#log?.opened();
    this.#send(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      }),
    );
    this.#link = this.deps.openSession(
      this.deps.sessions(),
      this.carrier,
      this.peer === undefined ? {} : { address: this.peer },
      this.#onProved,
    );
    this.#stop = this.#link.outbound.onReady(() => this.#drain());
    this.#drain();
  }
  fromClient(frame: SocketFrame): void {
    if (this.#ended) return;
    this.#lastFrameAt = this.deps.clock.now();
    this.#bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
    if (frame === HEARTBEAT_REQUEST) {
      this.#send(HEARTBEAT_RESPONSE);
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
          this.#send(
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
        this.#send(next.bytes);
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
    this.#report(ended);
  }
  /** One socket write, counted for the session's closing line. */
  #send(frame: Uint8Array | string): void {
    this.#bytesOut += typeof frame === 'string' ? frame.length : frame.byteLength;
    this.downstream.send(frame);
  }
  /**
   * The one line a tunnel session's end earns. A close with no report from the transport and none from this daemon is
   * the daemon releasing the socket itself — a shutdown, or a peer gone before it attached. Counts and timings only:
   * never a key, a device or an address.
   */
  #report(ended: SocketEnded | undefined): void {
    if (this.#log === undefined) return;
    const now = this.deps.clock.now();
    const here = this.#endedHere;
    this.#log.closed({
      by: here !== undefined || ended === undefined ? 'daemon' : 'peer',
      code: here?.code ?? ended?.code,
      reason: here?.reason ?? ended?.reason ?? 'the daemon released this socket',
      durationMs: now - this.#openedAt,
      lastFrameAgeMs: now - this.#lastFrameAt,
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      proved: this.#proved,
    });
  }
  evict(): void {
    this.#end(SESSION_CLOSE_CODES.rendezvousBusy, EVICTED_REASON);
  }
  #end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#endedHere = { code, reason };
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
