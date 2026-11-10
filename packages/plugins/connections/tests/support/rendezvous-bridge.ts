/**
 * THE WHOLE RELAYED PATH, IN PROCESS: a browser socket, the REAL rendezvous Durable Object, and the daemon's REAL relay
 * link in front of the REAL kernel session layer (`kernel-session.ts`). Today's `RelayBridge`
 * (pwa `relay-carrier-end-to-end.test.ts`), re-founded on 5.0's seams: the browser's walk and router dial through
 * `openSocket` (the shell's own port), the daemon end is `RelayLink` over `KernelFixture.layer`, and between them is
 * `RendezvousDurableObject` over the Workers fakes, so every frame crosses the rendezvous code that ships.
 *
 * `observed` is the rendezvous's ENTIRE view, in both directions: the end-to-end rows (R209, R184, R201's Linux proof)
 * search it for every value the rendezvous must never read. Work is serialised through one queue because a frame's
 * sequence number is its AEAD nonce: delivering two concurrently would prove the wrong thing.
 */
import type { BrowserSocket } from '../../app/adapters/browser-relay-dial.ts';
import { RelayLink } from '../../daemon/lib/relay/link.ts';
import { type RelayEnvironment, RendezvousDurableObject, type RelaySocket } from '../../worker/src/adapters/worker.ts';
import type { KernelFixture } from './kernel-session.ts';
import { FakeObjectState, type FakeSocket, testRuntime } from './worker/workers-fakes.ts';

const RELAY_HOST = 'relay.example';
export const RELAY_ORIGIN = `https://${RELAY_HOST}`;

const environment: RelayEnvironment = {
  RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
};

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A change a hostile rendezvous makes to a frame it was carrying to the browser; `undefined` leaves it as it was. */
export type Meddle = (bytes: Uint8Array) => Uint8Array | undefined;

interface ClientEndpoint {
  socket(): FakeSocket | undefined;
  receive(bytes: Uint8Array): void;
  /** Reports the close the rendezvous made, once. */
  closed(code: number, reason: string): void;
  reported: boolean;
}

export class RendezvousBridge {
  /** Every binary frame the rendezvous handled, in both directions: its entire view. */
  readonly observed: Uint8Array[] = [];
  readonly objectState = new FakeObjectState();
  readonly rendezvous: RendezvousDurableObject;
  /** Every URL a browser dialled. */
  readonly dialled: string[] = [];
  /** Applied to each frame the rendezvous hands a browser, to play a rendezvous that edits what it carries. */
  meddle: Meddle | undefined;
  #queue: (() => Promise<void>)[] = [];
  #running = false;
  #daemonSocket: FakeSocket | undefined;
  #link: RelayLink | undefined;
  readonly #clients: ClientEndpoint[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.rendezvous = new RendezvousDurableObject(this.objectState, environment, testRuntime());
  }

  /** Bring the daemon in first: the rendezvous refuses a client at a slot no daemon holds (4404). */
  async admitDaemon(fx: KernelFixture): Promise<RelayLink> {
    await this.rendezvous.fetch(
      new Request(`${RELAY_ORIGIN}/v1/rendezvous/${fx.daemonId}/daemon`, { headers: { Upgrade: 'websocket' } }),
    );
    const socket = this.objectState.sockets.at(-1);
    if (socket === undefined) throw new Error('the rendezvous accepted no daemon socket');
    this.#daemonSocket = socket;
    this.#link = new RelayLink({
      identity: fx.signer,
      relayHost: RELAY_HOST,
      layer: fx.layer,
      socket: {
        send: bytes => this.#toRendezvous(socket, bytes),
        sendText: () => undefined,
        close: () => undefined,
      },
      // A real timer left armed would outlive the case; every one is tracked and cancelled by `dispose`.
      scheduler: {
        after: (milliseconds, action) => {
          const handle = setTimeout(action, milliseconds);
          this.#timers.add(handle);
          return { cancel: () => clearTimeout(handle) };
        },
      },
    });
    this.#drain();
    await this.settle();
    return this.#link;
  }

  /** The browser's `openSocket`: the socket reaches the rendezvous, never the daemon. */
  readonly openSocket = (url: string): BrowserSocket => {
    this.dialled.push(url);
    const target = new URL(url);
    target.protocol = 'https:';
    let mine: FakeSocket | undefined;
    const adapted: BrowserSocket = {
      binaryType: 'blob',
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: data => {
        if (typeof data === 'string' || mine === undefined) return;
        this.#toRendezvous(mine, new Uint8Array(data));
      },
      close: () => undefined,
    };
    this.#clients.push({
      socket: () => mine,
      receive: bytes => adapted.onmessage?.({ data: buffer(bytes) }),
      closed: (code, reason) => adapted.onclose?.({ code, reason }),
      reported: false,
    });
    this.#enqueue(async () => {
      await this.rendezvous.fetch(new Request(target.href, { headers: { Upgrade: 'websocket' } }));
      mine = this.objectState.sockets.at(-1);
      adapted.onopen?.();
      this.#drain();
    });
    return adapted;
  };

  /** Wait until nothing is left to carry AND nothing new has crossed for several real turns (crypto answers late). */
  async settle(): Promise<void> {
    let quiet = 0;
    let seen = this.observed.length;
    for (let spin = 0; spin < 2_000 && quiet < 10; spin += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      if (this.#running || this.#queue.length > 0 || this.observed.length !== seen) quiet = 0;
      else quiet += 1;
      seen = this.observed.length;
    }
    if (quiet < 10) throw new Error('the bridge never went quiet');
  }

  /** Cancel every timer the daemon's link armed. */
  dispose(): void {
    for (const handle of this.#timers) clearTimeout(handle);
    this.#timers.clear();
  }

  #toRendezvous(socket: FakeSocket, bytes: Uint8Array): void {
    this.observed.push(Uint8Array.from(bytes));
    this.#enqueue(async () => {
      await this.rendezvous.webSocketMessage(socket as RelaySocket, buffer(bytes));
      this.#drain();
    });
  }

  /** Hand each endpoint whatever the rendezvous put in its outbox, in order; report a close it made on a browser. */
  #drain(): void {
    for (const client of this.#clients) {
      const socket = client.socket();
      if (socket === undefined) continue;
      for (const data of socket.sent.splice(0, socket.sent.length)) {
        if (typeof data === 'string') continue;
        const sent = new Uint8Array(data);
        const bytes = this.meddle?.(sent) ?? sent;
        this.observed.push(Uint8Array.from(sent));
        this.#enqueue(async () => {
          client.receive(bytes);
          this.#drain();
        });
      }
      if (socket.closed !== null && !client.reported) {
        client.reported = true;
        const { code, reason } = socket.closed;
        this.#enqueue(async () => client.closed(code ?? 1005, reason ?? ''));
      }
    }
    const daemon = this.#daemonSocket;
    if (daemon === undefined) return;
    for (const data of daemon.sent.splice(0, daemon.sent.length)) {
      if (typeof data === 'string') continue;
      const bytes = new Uint8Array(data);
      this.observed.push(bytes);
      this.#enqueue(async () => {
        await this.#link?.accept(bytes);
        this.#drain();
      });
    }
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue.push(task);
    void this.#run();
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (this.#queue.length > 0) {
      const task = this.#queue.shift();
      if (task !== undefined) await task();
    }
    this.#running = false;
  }
}

/**
 * Which secrets the rendezvous could actually READ, searched over the BYTES it handled: each secret as its UTF-8 bytes
 * and as the ASCII of its base64, the two encodings a leak plausibly takes on a wire that carries base64url payloads.
 * A hit names the LABEL and the frame index and never the value.
 */
export function carrierLeaks(
  bridge: { readonly observed: readonly Uint8Array[] },
  secrets: Readonly<Record<string, string>>,
): readonly string[] {
  const haystack = bridge.observed.map(bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const leaks: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    if (secret === '') throw new Error(`the leak search was given an empty needle for ${label}`);
    const needles = [Buffer.from(secret, 'utf8'), Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8')];
    for (const [index, frame] of haystack.entries()) {
      if (needles.some(needle => frame.includes(needle))) {
        leaks.push(`${label} appeared in relay-observable frame #${String(index)}`);
        break;
      }
    }
  }
  return leaks;
}
