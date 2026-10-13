/**
 * A device, as a test drives one: a key it cannot export, and the client half of a session.
 *
 * A paired device no longer has a token a test could put in a header. It proves a key inside a sealed
 * session, on either carrier, so a test that wants to act as a device opens one — over the daemon's
 * direct socket here, with the relay package's own handshake and record code, so what a daemon test
 * proves is what a browser would meet. It is deliberately small: one session, requests in order,
 * credit returned as records are read, and nothing a real client would need beyond that.
 */

import { type PairingResponse, PairingResponseSchema } from '@ferretry/protocol';
import {
  type ChannelState,
  completeClientHandshake,
  creditToReturn,
  decodeControlMessage,
  decodeDaemonHello,
  decodeFrame,
  deviceAuthMessage,
  devicePairMessage,
  encodeCreditPayload,
  encodeFrame,
  encodeHandshakeMessage,
  FRAME_KINDS,
  HANDSHAKE_FRAME_SEQUENCE,
  newReceiveWindow,
  openChannel,
  openRecord,
  type PrivateKeyHandle,
  type ReceiveWindow,
  type RelayFrame,
  recordConsumed,
  recordCredited,
  SESSION_PROTOCOL_ID,
  sealRecord,
  signDeviceProof,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
  utf8Text,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';

const crypto_ = new WebCryptoRelayCrypto();

export interface TestDevice {
  readonly key: PrivateKeyHandle;
  /** The SPKI the daemon will store, base64url. */
  readonly publicKey: string;
}

/** A fresh non-extractable device key, exactly as the browser makes one. */
export async function newTestDevice(): Promise<TestDevice> {
  const generated = await crypto_.generateDeviceKey();
  return { key: crypto_.deviceKeyHandle(generated.privateKey), publicKey: toBase64Url(generated.publicKeySpki) };
}

/** Where a session closed: the code and reason a `closed` control or the socket said. */
export interface TestSessionClose {
  readonly code: number;
  readonly reason: string;
}

export interface TestAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type Mode =
  | { readonly kind: 'auth'; readonly deviceId: string; readonly device: TestDevice }
  | { readonly kind: 'pair'; readonly code: string; readonly deviceName: string; readonly device: TestDevice };

const APP_SESSION = toBase64Url(new Uint8Array(16).fill(3));

/** One session over one direct socket. */
export class TestSession {
  #channel: ChannelState | undefined;
  #transcript: Uint8Array | undefined;
  #receive: ReceiveWindow = newReceiveWindow();
  #nextId = 1;
  #inbox: unknown[] = [];
  #waiters: Array<(message: unknown) => void> = [];
  #closed: TestSessionClose | undefined;
  readonly #closeWaiters: Array<(closed: TestSessionClose) => void> = [];
  #queue: Promise<void> = Promise.resolve();

  private constructor(private readonly socket: WebSocket) {}

  /**
   * Opens a direct session to `baseUrl` for `daemonId` and sends the credential record for `mode`.
   *
   * Resolves once the record is sent; read the daemon's first answer with {@link next}.
   */
  static async open(
    baseUrl: string,
    daemonId: string,
    mode: Mode,
    options: { readonly origin?: string } = {},
  ): Promise<TestSession> {
    const url = new URL(`/v1/rendezvous/${daemonId}/client`, baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // Bun's client accepts headers, which is how a test plays a browser on a given origin.
    const socket = new WebSocket(url.toString(), {
      headers: options.origin === undefined ? {} : { origin: options.origin },
    } as unknown as string[]);
    socket.binaryType = 'arraybuffer';
    const session = new TestSession(socket);
    const keyed = new Promise<void>((resolve, reject) => {
      let pending: Awaited<ReturnType<typeof startClientHandshake>> | undefined;
      socket.onmessage = event => {
        session.#queue = session.#queue.then(async () => {
          if (typeof event.data === 'string') return;
          const decoded = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
          if (!decoded.ok) return reject(new Error(decoded.reason));
          const frame = decoded.frame;
          if (frame.kind === FRAME_KINDS.control) {
            const control = decodeControlMessage(frame.payload);
            if (control?.t === 'ready') {
              pending = await startClientHandshake(crypto_, frame.sessionId, daemonId);
              socket.send(
                encodeFrame({
                  kind: FRAME_KINDS.handshake,
                  sessionId: frame.sessionId,
                  sequence: HANDSHAKE_FRAME_SEQUENCE,
                  payload: encodeHandshakeMessage(pending.hello),
                }),
              );
            } else if (control?.t === 'closed') {
              session.#ended({ code: control.code, reason: control.reason });
              reject(new Error(`the daemon ended the session: ${control.code} ${control.reason}`));
            }
            return;
          }
          if (frame.kind === FRAME_KINDS.handshake && pending !== undefined) {
            const hello = decodeDaemonHello(frame.payload);
            const completed = hello === null ? undefined : await completeClientHandshake(crypto_, pending, hello);
            if (completed === undefined || !completed.ok) return reject(new Error('the handshake did not complete'));
            session.#channel = openChannel(frame.sessionId, completed.keys, 'client');
            session.#transcript = completed.keys.transcriptHash;
            session.#consume(frame);
            await session.#send(await session.#credential(mode));
            resolve();
            return;
          }
          if (frame.kind === FRAME_KINDS.data) await session.#onRecord(frame);
        });
      };
      socket.onclose = event => {
        session.#ended({ code: event.code, reason: event.reason });
        reject(new Error(`the socket closed before the session was keyed: ${event.code}`));
      };
    });
    await keyed;
    return session;
  }

  /** The next record the daemon sent, parsed. */
  async next(): Promise<unknown> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return queued;
    return await new Promise(resolve => this.#waiters.push(resolve));
  }

  /** How the session ended, once it has. */
  async closed(): Promise<TestSessionClose> {
    if (this.#closed !== undefined) return this.#closed;
    return await new Promise(resolve => this.#closeWaiters.push(resolve));
  }

  /** One request, answered in one record (a test body is never large enough to need parts). */
  async request(
    method: string,
    path: string,
    options: { readonly body?: string; readonly headers?: Readonly<Record<string, string>> } = {},
  ): Promise<TestAnswer> {
    const id = this.#nextId;
    this.#nextId += 1;
    await this.#send({
      t: 'req',
      id,
      method,
      path,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    const answer = (await this.next()) as { t: string; id: number; status: number; headers?: Record<string, string>; body?: string };
    if (answer.t !== 'res' || answer.id !== id) throw new Error(`expected the answer to ${id}, got ${JSON.stringify(answer)}`);
    return { status: answer.status, headers: answer.headers ?? {}, body: answer.body ?? '' };
  }

  close(): void {
    this.socket.close(1000, 'done');
  }

  async #credential(mode: Mode): Promise<unknown> {
    const transcript = this.#transcript ?? new Uint8Array();
    if (mode.kind === 'pair')
      return {
        t: 'pair',
        protocol: SESSION_PROTOCOL_ID,
        code: mode.code,
        deviceName: mode.deviceName,
        deviceKey: mode.device.publicKey,
        proof: await signDeviceProof(crypto_, mode.device.key, devicePairMessage(transcript, mode.device.publicKey)),
      };
    return {
      t: 'auth',
      protocol: SESSION_PROTOCOL_ID,
      deviceId: mode.deviceId,
      appSession: APP_SESSION,
      proof: await signDeviceProof(
        crypto_,
        mode.device.key,
        deviceAuthMessage(transcript, 'auth', mode.deviceId, APP_SESSION),
      ),
    };
  }

  async #send(message: unknown): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('the session is not keyed');
    const sealed = await sealRecord(crypto_, channel, utf8Bytes(JSON.stringify(message)));
    if (!sealed.ok) throw new Error(sealed.reason);
    this.#channel = { ...channel, sendSequence: sealed.state.sendSequence };
    this.socket.send(encodeFrame(sealed.frame));
  }

  async #onRecord(frame: RelayFrame): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) return;
    const opened = await openRecord(crypto_, channel, frame);
    if (!opened.ok) throw new Error(opened.reason);
    this.#channel = { ...(this.#channel ?? channel), receiveSequence: opened.state.receiveSequence };
    this.#consume(frame);
    const message = JSON.parse(utf8Text(opened.plaintext) ?? 'null') as unknown;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#inbox.push(message);
    else waiter(message);
  }

  /** Return credit the way the protocol asks: once half a window is owed. */
  #consume(frame: RelayFrame): void {
    this.#receive = recordConsumed(this.#receive);
    const owed = creditToReturn(this.#receive);
    if (owed === 0) return;
    this.#receive = recordCredited(this.#receive, owed);
    this.socket.send(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: frame.sessionId, sequence: 0, payload: encodeCreditPayload(owed) }),
    );
  }

  #ended(closed: TestSessionClose): void {
    if (this.#closed !== undefined) return;
    this.#closed = closed;
    for (const waiter of this.#closeWaiters.splice(0)) waiter(closed);
  }
}

/**
 * Redeems a pairing code over a direct session and answers what the daemon sealed back.
 *
 * `paired` carries the redemption response; `refused` is the one generic refusal.
 */
export async function pairOverSession(
  baseUrl: string,
  daemonId: string,
  code: string,
  deviceName: string,
  device: TestDevice,
): Promise<{ readonly kind: 'paired'; readonly response: PairingResponse } | { readonly kind: 'refused' }> {
  const session = await TestSession.open(baseUrl, daemonId, { kind: 'pair', code, deviceName, device });
  const outcome = (await session.next()) as { t: string; response?: unknown };
  session.close();
  return outcome.t === 'paired'
    ? { kind: 'paired', response: PairingResponseSchema.parse(outcome.response) }
    : { kind: 'refused' };
}

/** Opens an authenticated request session for a paired device, after the daemon accepted it. */
export async function deviceSession(
  baseUrl: string,
  daemonId: string,
  deviceId: string,
  device: TestDevice,
  options: { readonly origin?: string } = {},
): Promise<TestSession> {
  const session = await TestSession.open(baseUrl, daemonId, { kind: 'auth', deviceId, device }, options);
  const accepted = (await session.next()) as { t: string };
  if (accepted.t !== 'authenticated') throw new Error(`the daemon did not accept the device: ${JSON.stringify(accepted)}`);
  return session;
}
