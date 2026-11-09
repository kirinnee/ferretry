import type { Manifest } from '@ferretry/kernel/manifest';
import type {
  DaemonTransport,
  RawEvent,
  SocketListeners,
  TransportAnswer,
  TransportRequest,
  TransportSocket,
} from '../../../src/client/transport.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';

/** A minimal compiled package for the client tests. */
export function surface(
  id: string,
  options: {
    core?: boolean;
    contract?: string;
    consumes?: readonly string[];
    routes?: readonly string[];
    sockets?: readonly string[];
  } = {},
): SurfaceEntry {
  const manifest = {
    id,
    title: id[0]?.toUpperCase() + id.slice(1),
    version: '5.0.0',
    api: 5,
    core: options.core ?? false,
    kinds: [],
    actions: {
      routes: (options.routes ?? []).map(key => ({ key, minimum: 'authenticated', caller: 'any', audit: 'skip' })),
      sockets: (options.sockets ?? []).map(key => ({ key, minimum: 'authenticated', caller: 'any', audit: 'skip' })),
    },
  } as unknown as Manifest;
  return {
    id,
    title: manifest.title,
    core: manifest.core,
    contract: options.contract ?? `h-${id}`,
    consumes: options.consumes ?? [],
    manifest,
  };
}

export const CORE = ['kernel', 'gate', 'vault', 'ferrets', 'asks'].map(id => surface(id, { core: true }));

export function inventoryOf(
  entries: readonly SurfaceEntry[],
  overrides: Readonly<Record<string, { on?: boolean; contract?: string } | null>> = {},
): unknown {
  return {
    protocol: 1,
    plugins: entries
      .filter(entry => overrides[entry.id] !== null)
      .map(entry => ({
        id: entry.id,
        on: overrides[entry.id]?.on ?? true,
        contract: overrides[entry.id]?.contract ?? entry.contract,
      })),
  };
}

/** A scripted transport: records every request, answers from a handler, and lets a test push events. */
export class FakeTransport implements DaemonTransport {
  readonly requests: TransportRequest[] = [];
  readonly sockets: { path: string; closed: boolean; listeners: SocketListeners }[] = [];
  eventStreams = 0;
  #eventListener: ((event: RawEvent) => void) | undefined;
  #feedClosed: ((reason: string) => void) | undefined;
  #feedOpened: (() => void) | undefined;
  #reconnect = new Set<() => void>();

  constructor(public answer: (request: TransportRequest) => Promise<TransportAnswer> | TransportAnswer) {}

  async request(request: TransportRequest): Promise<TransportAnswer> {
    this.requests.push(request);
    return this.answer(request);
  }

  events(listener: (event: RawEvent) => void, onClose?: (reason: string) => void, onOpen?: () => void): () => void {
    this.eventStreams += 1;
    this.#eventListener = listener;
    this.#feedClosed = onClose;
    this.#feedOpened = onOpen;
    return () => {
      this.#eventListener = undefined;
    };
  }

  socket(path: string, listeners: SocketListeners): TransportSocket {
    const record = { path, closed: false, listeners };
    this.sockets.push(record);
    return {
      send: () => {},
      close: () => {
        record.closed = true;
      },
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect.add(listener);
    return () => this.#reconnect.delete(listener);
  }

  /** The event feed answered: the client's feed is live. */
  openFeed(): void {
    this.#feedOpened?.();
  }

  /** The event feed dropped. */
  dropFeed(): void {
    this.#feedClosed?.('dropped');
  }

  emit(event: RawEvent): void {
    this.#eventListener?.(event);
  }

  reconnect(): void {
    for (const listener of this.#reconnect) listener();
  }

  paths(): string[] {
    return this.requests.map(request => `${request.method} ${request.path}`);
  }
}

export const json = (body: unknown, status = 200): TransportAnswer => ({ status, headers: {}, body });
