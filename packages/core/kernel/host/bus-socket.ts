/**
 * `GET /v1/bus` (the kernel's own socket): the plugin event bus, one `{ name, payload }` JSON frame per event, for
 * `PluginClient.subscribe` in the CLI and the app's session transport. An event is shown to a caller only when the
 * plugin that publishes it is one that caller's admission lets it discover (the same projection `GET /v1/plugins`
 * answers with: "a plugin with a route, tool or event its grants admit"), asked once on arrival and again immediately
 * before the write. The feed is server-only; a reader that falls behind is closed rather than buffered without end.
 */
import {
  SOCKET_MAX_FRAME_BYTES,
  type SocketAccept,
  type SocketAttachment,
  type SocketDownstream,
  type SocketHandler,
} from '../contract/socket.ts';
import type { ApiRequest } from '../contract/http.ts';

/** A slow reader may hold at most this much in the host socket (the Ferrets event stream's bound). */
const BUS_MAX_BUFFER_BYTES = 1_024 * 1_024;

const BUS_CLOSES = {
  clientFrame: { code: 1008, reason: 'event feed is server-only' },
  slowReader: { code: 1013, reason: 'event feed reader fell behind' },
} as const;

export interface BusSources {
  /** Every delivered event, in publish order; returns the cancel. */
  subscribe(listener: (name: string, payload: unknown) => void): () => void;
  /** The plugin that declared it publishes this event; `undefined` for a name nobody declared. */
  publisher(name: string): string | undefined;
  /** Whether this caller's admission lets it discover `plugin` now. */
  admits(request: ApiRequest, plugin: string): boolean;
}

const encoder = new TextEncoder();

class BusHandler implements SocketHandler {
  #cancel: (() => void) | undefined;
  #closed = false;

  constructor(
    private readonly sources: BusSources,
    private readonly request: ApiRequest,
    private readonly downstream: SocketDownstream,
  ) {}

  async open(): Promise<void> {
    if (this.#closed) return;
    this.#cancel = this.sources.subscribe((name, payload) => this.#deliver(name, payload));
  }

  #deliver(name: string, payload: unknown): void {
    if (this.#closed) return;
    const owner = this.sources.publisher(name);
    if (owner === undefined || !this.sources.admits(this.request, owner)) return;
    let text: string;
    try {
      text = JSON.stringify({ name, payload });
    } catch {
      return;
    }
    // A frame the socket could not carry is a wake-up this reader misses; the reader polls on its own as well.
    if (encoder.encode(text).length > SOCKET_MAX_FRAME_BYTES) return;
    this.downstream.send(text, () => this.sources.admits(this.request, owner));
    if (this.downstream.bufferedBytes() > BUS_MAX_BUFFER_BYTES) this.#end(BUS_CLOSES.slowReader);
  }

  fromClient(): void {
    this.#end(BUS_CLOSES.clientFrame);
  }

  close(): void {
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #end(why: { readonly code: number; readonly reason: string }): void {
    this.close();
    this.downstream.close(why.code, why.reason);
  }
}

/** The accept for `GET /v1/bus`. */
export function busAccept(sources: BusSources): SocketAccept {
  return async call => {
    const attachment: SocketAttachment = async downstream => new BusHandler(sources, call.request, downstream);
    return attachment;
  };
}
