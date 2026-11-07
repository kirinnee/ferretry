/** Carrier half of today’s relay/link.ts. The Kernel owns each sealed session. */
import { isSessionEnd, type CarrierKey, type CarrierLink, type SessionLayer } from '@ferretry/kernel/contract';
import {
  claimContextForChallenge,
  decodeFrame,
  encodeClaim,
  encodeFrame,
  FRAME_KINDS,
  fromBase64UrlFixed,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  NONCE_BYTES,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type RelayCloseCode,
  type RelayFrame,
  type SessionId,
} from '../wire-mirror/index.ts';
import { decodeControlMessage, encodeControlMessage, type ControlMessage } from './control.ts';
import type { RelayLinkScheduler, RelayLinkSocket, RelayLinkTimer, RendezvousSigner } from './session-ports.ts';
export type { RelayLinkScheduler, RelayLinkSocket, RelayLinkTimer } from './session-ports.ts';

const RELAY_ENDED_SESSION_GRACE_MS = 45_000;
const RELAY_MAX_ENDED_SESSIONS = 64;
interface LinkSession {
  readonly link: CarrierLink;
  readonly sessionId: SessionId;
  stop(): void;
}
export interface RelayLinkDependencies {
  readonly identity: RendezvousSigner;
  readonly relayHost: string;
  readonly layer: SessionLayer;
  readonly socket: RelayLinkSocket;
  readonly scheduler: RelayLinkScheduler;
  readonly replaces?: string;
}
export class RelayLink {
  readonly #sessions = new Map<string, LinkSession>();
  readonly #ended = new Map<string, RelayLinkTimer>();
  #claimed = false;
  #claimProbe = false;
  #held = 0;
  #handover: string | undefined;
  #lastRefusal: string | undefined;
  #closed = false;
  constructor(private readonly deps: RelayLinkDependencies) {}
  report() {
    return {
      claimed: this.#claimed,
      claimProbe: this.#claimProbe,
      held: this.#held,
      handover: this.#handover,
      sessions: this.#sessions.size,
      lastRefusal: this.#lastRefusal,
    };
  }
  heartbeat(): void {
    this.deps.socket.sendText(HEARTBEAT_REQUEST);
  }
  probeClaim(): void {
    if (!this.#claimProbe) return;
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId: RENDEZVOUS_SESSION_ID,
      sequence: 0,
      payload: encodeControlMessage({ t: 'probe' }),
    });
  }
  receiveText(text: string): void {
    if (this.#closed) return;
    if (text === HEARTBEAT_REQUEST) {
      this.deps.socket.sendText(HEARTBEAT_RESPONSE);
      return;
    }
    if (text === HEARTBEAT_RESPONSE) return;
    this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'the carrier sent an unknown text message');
  }
  async accept(bytes: Uint8Array): Promise<{ settled: Promise<void> }> {
    if (this.#closed) return { settled: Promise.resolve() };
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) this.#refuseSocket(decoded.code, decoded.reason);
    else if (decoded.frame.kind === FRAME_KINDS.control) await this.#onControl(decoded.frame);
    else {
      const session = this.#sessions.get(decoded.frame.sessionId.text);
      if (session !== undefined) session.link.inbound(bytes);
      else if (!this.#ended.has(decoded.frame.sessionId.text))
        this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a frame named no live session');
    }
    return { settled: Promise.resolve() };
  }
  #onOpen(sessionId: SessionId): void {
    if (this.#sessions.has(sessionId.text)) {
      this.#endSession(sessionId, RELAY_CLOSE_CODES.protocolError, 'this session identifier is already live');
      return;
    }
    this.#ended.get(sessionId.text)?.cancel();
    this.#ended.delete(sessionId.text);
    const link = this.deps.layer.open('relay' as CarrierKey);
    let draining = false;
    const session: LinkSession = { link, sessionId, stop: () => undefined };
    const drain = (): void => {
      if (draining || this.#closed || this.#sessions.get(sessionId.text) !== session) return;
      draining = true;
      try {
        while (this.#sessions.get(sessionId.text) === session) {
          const next = link.outbound.next();
          if (next === undefined) break;
          if (isSessionEnd(next)) {
            this.#endSession(sessionId, next.code, next.reason);
            break;
          }
          // The Kernel asked the permit inside next(). No await or queued write may follow it.
          this.deps.socket.send(next.bytes);
        }
      } catch {
        this.#refuseSocket(RELAY_CLOSE_CODES.relayInternal, 'the daemon could not carry this frame');
      } finally {
        draining = false;
      }
    };
    this.#sessions.set(sessionId.text, session);
    session.stop = link.outbound.onReady(drain);
    drain();
  }
  #endSession(sessionId: SessionId, code: number, reason: string): void {
    const session = this.#sessions.get(sessionId.text);
    if (session !== undefined) {
      session.stop();
      session.link.closed(reason);
    }
    this.#sessions.delete(sessionId.text);
    this.#rememberEnded(sessionId);
    this.#lastRefusal = `session ${code}: ${reason}`;
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId,
      sequence: 0,
      payload: encodeControlMessage({ t: 'closed', code, reason }),
    });
  }
  #sendFrame(frame: RelayFrame): void {
    if (!this.#closed) this.deps.socket.send(encodeFrame(frame));
  }
  #refuseSocket(code: RelayCloseCode, reason: string): void {
    this.#lastRefusal = `link ${code}: ${reason}`;
    this.close();
    this.deps.socket.close(code, reason);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions.values()) {
      session.stop();
      session.link.closed('the rendezvous connection ended');
    }
    this.#sessions.clear();
    for (const timer of this.#ended.values()) timer.cancel();
    this.#ended.clear();
  }
  async #onControl(frame: RelayFrame): Promise<void> {
    const message = decodeControlMessage(frame.payload);
    if (message === null) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'unparseable rendezvous control');
      return;
    }
    switch (message.t) {
      case 'challenge':
        await this.#onChallenge(message);
        return;
      case 'claimed':
        this.#claimed = true;
        this.#claimProbe = message.features?.includes('claim-probe') === true;
        // Only a rendezvous that echoed the feature may issue a token; a stray one is not remembered.
        this.#handover = message.features?.includes('claim-handover') === true ? message.handover : undefined;
        return;
      case 'held':
        this.#held += 1;
        return;
      case 'open':
        this.#onOpen(frame.sessionId);
        return;
      case 'closed': {
        // Whatever this session was carrying goes with it. A stream handler holds a redraw timer and
        // a viewer slot armed against a peer the rendezvous has just told us is gone, and forgetting
        // the session without releasing it would leave both firing at nothing.
        const ended = this.#sessions.get(frame.sessionId.text);
        if (ended !== undefined) {
          ended.stop();
          ended.link.closed(message.reason);
        }
        this.#sessions.delete(frame.sessionId.text);
        this.#lastRefusal = `the rendezvous ended a session: ${message.code} ${message.reason}`;
        return;
      }
      case 'error':
        // The rendezvous closes the socket immediately after this, so there is nothing to do but
        // keep the reason. Closing from here as well would race its own close frame.
        this.#lastRefusal = `the rendezvous refused this daemon: ${message.code} ${message.reason}`;
        return;
      default:
        // `ready` and `claim` belong to the other two roles. Receiving one means this is not the
        // conversation the daemon thinks it is in.
        this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, `unexpected rendezvous control: ${message.t}`);
    }
  }

  /**
   * Answer the challenge, or refuse to.
   *
   * The host in the challenge must be the host this daemon dialled. A signature over somebody else's
   * host is exactly what a hostile relay would like to collect, so the refusal is not politeness — it
   * is the reason the host is in the transcript at all.
   */
  async #onChallenge(message: Extract<ControlMessage, { t: 'challenge' }>): Promise<void> {
    if (this.#claimed) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'a second challenge arrived after the claim');
      return;
    }
    const challenge = fromBase64UrlFixed(message.nonce, NONCE_BYTES);
    if (challenge === null) {
      this.#refuseSocket(RELAY_CLOSE_CODES.protocolError, 'the challenge nonce is malformed');
      return;
    }
    const context = claimContextForChallenge(this.deps.identity.daemonId, this.deps.relayHost, message.host, challenge);
    if (context === null) {
      this.#refuseSocket(
        RELAY_CLOSE_CODES.protocolError,
        `the rendezvous named host ${JSON.stringify(message.host)}, which this daemon did not configure`,
      );
      return;
    }
    const claim = await this.deps.identity.signClaim(context);
    if (this.#closed) return;
    this.#sendFrame({
      kind: FRAME_KINDS.control,
      sessionId: RENDEZVOUS_SESSION_ID,
      sequence: 0,
      payload: encodeControlMessage({
        t: 'claim',
        protocol: RELAY_PROTOCOL_ID,
        ...encodeClaim(claim),
        ...(this.deps.replaces === undefined ? {} : { replaces: this.deps.replaces }),
      }),
    });
  }

  /** Remember that this daemon ended a session, for as long as a frame for it may still be in flight. */
  #rememberEnded(sessionId: SessionId): void {
    const key = sessionId.text;
    this.#ended.get(key)?.cancel();
    this.#ended.delete(key);
    if (this.#ended.size >= RELAY_MAX_ENDED_SESSIONS) {
      const [oldest, timer] = this.#ended.entries().next().value as [string, RelayLinkTimer];
      timer.cancel();
      this.#ended.delete(oldest);
    }
    const timer = this.deps.scheduler.after(RELAY_ENDED_SESSION_GRACE_MS, () => {
      if (this.#ended.get(key) === timer) this.#ended.delete(key);
    });
    this.#ended.set(key, timer);
  }
}
