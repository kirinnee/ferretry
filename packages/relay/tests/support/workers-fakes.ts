/**
 * The Workers runtime, faked down to what this adapter touches.
 *
 * Cloudflare's Durable Object runtime cannot run in this repository's harness, so what is proved
 * here is the adapter's half of the contract: which runtime calls it makes, in what order, and what
 * it does with the answers. What is NOT proved here is that Cloudflare behaves as these fakes do —
 * that claim is only ever made by a real deployment, and the protocol document says so plainly.
 */

import type { RelayObjectState, RelayRuntime, RelaySocket, RelayStorage } from '../../src/adapters/index.ts';
import { decodeFrame, type RelayFrame } from '../../src/lib/index.ts';
import { relayCrypto } from './identities.ts';

export class FakeSocket implements RelaySocket {
  readonly sent: (ArrayBuffer | string)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;

  send(data: ArrayBuffer | string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** Everything this socket was sent, decoded back into frames. */
  frames(): RelayFrame[] {
    return this.sent.flatMap(data => {
      if (typeof data === 'string') return [];
      const decoded = decodeFrame(new Uint8Array(data));
      return decoded.ok ? [decoded.frame] : [];
    });
  }

  drain(): RelayFrame[] {
    const frames = this.frames();
    this.sent.length = 0;
    return frames;
  }
}

class FakeStorage implements RelayStorage {
  readonly values = new Map<string, unknown>();
  readonly alarms: number[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
}

export class FakeObjectState implements RelayObjectState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  readonly lastSeen = new Map<RelaySocket, Date | null>();
  autoResponse: unknown = null;

  acceptWebSocket(socket: RelaySocket): void {
    this.sockets.push(socket as FakeSocket);
  }

  getWebSockets(): RelaySocket[] {
    return this.sockets;
  }

  setWebSocketAutoResponse(pair: unknown): void {
    this.autoResponse = pair;
  }

  getWebSocketAutoResponseTimestamp(socket: RelaySocket): Date | null {
    return this.lastSeen.get(socket) ?? null;
  }
}

export interface TestRuntime extends RelayRuntime {
  /** Every pair handed out, newest last, so a test can address the socket it just created. */
  readonly pairs: { readonly client: FakeSocket; readonly server: FakeSocket }[];
  clock: number;
}

export function testRuntime(overrides: Partial<RelayRuntime> = {}): TestRuntime {
  const pairs: { client: FakeSocket; server: FakeSocket }[] = [];
  const runtime: TestRuntime = {
    pairs,
    clock: 1_000,
    crypto: relayCrypto,
    now: () => runtime.clock,
    createSocketPair: () => {
      const pair = { client: new FakeSocket(), server: new FakeSocket() };
      pairs.push(pair);
      return pair;
    },
    upgradeResponse: () => new Response(null, { status: 200 }),
    heartbeatPair: () => 'heartbeat',
    ...overrides,
  };
  return runtime;
}
