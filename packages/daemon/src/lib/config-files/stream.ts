/**
 * The configuration stream, `/v1/events?topic=config` (docs/config-files.md "Live changes").
 *
 * The first frame is where the revision stands, naming no kinds; every frame after it is one counted
 * change. Nothing is replayed — the revision is the whole of what a reader needs to know whether it
 * missed something — so opening it costs one frame, which is what lets a reader reopen it whenever
 * the app comes back to the foreground. A quiet stream sends the same keep-alive proof the session
 * stream does, so a reader can tell quiet from broken.
 */

import { type ConfigChangeFrame, ConfigChangeFrameSchema } from '@ferretry/protocol';
import type { SocketDownstream, SocketFrame, SocketHandler } from '../api/socket.ts';
import {
  EVENT_STREAM_IDLE_MS,
  EVENT_STREAM_MAX_BUFFER_BYTES,
  type EventStreamScheduler,
} from '../session/events/index.ts';
import type { ConfigChange, ConfigChangeLedger } from './changes.ts';

export const CONFIG_STREAM_CLOSES = {
  clientFrame: { code: 1008, reason: 'event stream is server-only' },
  slowReader: { code: 1013, reason: 'event stream reader fell behind' },
} as const;

/** The ledger as the stream reads it. */
export type ConfigChangeSource = Pick<ConfigChangeLedger, 'current' | 'subscribe'>;

class ConfigChangeSocketHandler implements SocketHandler {
  #unsubscribe: (() => void) | undefined;
  #idle: { cancel(): void } | undefined;
  #closed = false;

  constructor(
    private readonly source: ConfigChangeSource,
    private readonly scheduler: EventStreamScheduler,
    private readonly downstream: SocketDownstream,
  ) {}

  async open(): Promise<void> {
    if (this.#closed) return;
    // Subscribed before the first frame is read, so a change counted in between is never lost: it
    // arrives as the next frame, at a revision past the one the first frame said.
    this.#unsubscribe = this.source.subscribe(change => this.#change(change));
    if (this.#send({ kind: 'config', ...this.source.current(), kinds: [] })) this.#armIdle();
  }

  #change(change: ConfigChange): void {
    if (this.#send({ kind: 'config', epoch: change.epoch, revision: change.revision, kinds: [...change.kinds] }))
      this.#armIdle();
  }

  #send(frame: ConfigChangeFrame): boolean {
    if (this.#closed) return false;
    if (this.downstream.bufferedBytes() > EVENT_STREAM_MAX_BUFFER_BYTES) {
      this.#fail(CONFIG_STREAM_CLOSES.slowReader);
      return false;
    }
    let sent: number | undefined;
    try {
      sent = this.downstream.send(JSON.stringify(ConfigChangeFrameSchema.parse(frame)));
    } catch {
      sent = undefined;
    }
    if (sent === undefined || sent < 0) {
      this.close();
      return false;
    }
    return true;
  }

  /** Every quiet window, not once: the proof is also what keeps every hop between the ends alive. */
  #armIdle(): void {
    this.#idle?.cancel();
    this.#idle = this.scheduler.after(EVENT_STREAM_IDLE_MS, () => {
      this.#idle = undefined;
      if (this.#send({ kind: 'idle', ...this.source.current(), idleSeconds: EVENT_STREAM_IDLE_MS / 1_000 }))
        this.#armIdle();
    });
  }

  #fail(close: { readonly code: number; readonly reason: string }): void {
    if (this.#closed) return;
    this.close();
    this.downstream.close(close.code, close.reason);
  }

  fromClient(_frame: SocketFrame): void {
    this.#fail(CONFIG_STREAM_CLOSES.clientFrame);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#idle?.cancel();
    this.#idle = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}

/** One handler per accepted socket. */
export class ConfigChangeStreamService {
  constructor(
    private readonly source: ConfigChangeSource,
    private readonly scheduler: EventStreamScheduler,
  ) {}

  handler(downstream: SocketDownstream): SocketHandler {
    return new ConfigChangeSocketHandler(this.source, this.scheduler, downstream);
  }
}
