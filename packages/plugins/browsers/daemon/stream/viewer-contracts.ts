import type { BrowserInputEvent, BrowserScreencastFrame } from '../../contract/wire/browser.ts';

/** A viewer's socket, seen from the domain: binary frame chunks out, a close code at the end. */
export interface ViewerDownstream {
  /**
   * `0` means the transport dropped the message; anything else (including nothing) is accepted. `permit` is the transport's
   * own final guard (the kernel's `SocketDownstream.send` permit): asked synchronously right where the bytes would leave,
   * and a `false` sends nothing.
   */
  send(envelope: Uint8Array, permit?: () => boolean): number | void;
  close(code: number, reason: string): void;
  /** Bytes still queued in the transport, when it can report them. */
  bufferedBytes?(): number;
}

/** Why a stream ended, as the browser session sees it. */
export interface ViewerTerminalSignal {
  readonly code: number;
  readonly reason: string;
}

/** Frees the viewer slot the stream holds on the browser session. */
export interface ViewerAttachment {
  detach(): void;
}

/**
 * The browser session, seen from the transport. Implemented by the browser service; declared here so
 * the transport never depends on it in the other direction.
 */
export interface BrowserViewerHost {
  attachViewer(
    sessionId: string,
    onFrame: (frame: BrowserScreencastFrame) => void,
    onTerminal: (signal: ViewerTerminalSignal) => void,
  ): Promise<ViewerAttachment>;
  dispatchHumanInput(sessionId: string, input: BrowserInputEvent): Promise<void>;
}

/**
 * The delivery check an AGENT's viewer stream makes where a frame would leave (sealed output, docs/secure-copy.md): the stamp is
 * taken when a frame arrives and the check is asked, synchronously, before EVERY send of it, a retry of a frame held for a
 * congested socket included. A frame that fails it is dropped and the stream ends with `refusal`.
 */
export interface ViewerDeliveryGuard {
  /** Taken where a frame ARRIVES (before anything is awaited), for the page it shows when the guard knows it. */
  stamp(pageId?: string): unknown;
  mayDeliver(stamp: unknown): boolean;
  /** The sentence the stream ends with when {@link mayDeliver} said no (or a permission was withdrawn). */
  readonly refusal: string;
  /** Asked once for a page before its frames are delivered: `false` ends the stream with {@link refusal}. */
  admit?(pageId: string): Promise<boolean>;
  /**
   * Called when the stream attaches: `onRevoked` must be called, synchronously, the moment a permission this guard holds is
   * withdrawn (a value begins to be sealed, a person takes the page over), with the sentence to end the stream with.
   * Returns what stops watching.
   */
  watch?(onRevoked: (reason: string) => void): () => void;
}

export interface ViewerStreamOptions {
  /** Set for an agent's viewer only: a person's stream is never asked. */
  readonly delivery?: ViewerDeliveryGuard | undefined;
  /** Largest single client message accepted before the stream is a protocol violation. */
  readonly maxInputMessageBytes?: number;
  /** Total in-flight client bytes tolerated before the client is judged to be flooding. */
  readonly maxQueuedInputBytes?: number;
  /** Buffered downstream bytes above which a frame waits instead of being queued behind others. */
  readonly maxBufferedBytes?: number;
  /** How often a retained frame retries while the transport is congested. */
  readonly recoveryPollMs?: number;
  /**
   * The largest message the transport carries whole, which a frame is chunked to fit. Defaults to the
   * raw byte budget of one §14 `data` record, because every viewer stream is a stream session.
   */
  readonly chunkBytes?: number;
}

/** WebSocket close codes the transport uses, named so call sites read as decisions. */
export const VIEWER_CLOSE_NORMAL = 1000;
export const VIEWER_CLOSE_POLICY = 1008;
export const VIEWER_CLOSE_TOO_LARGE = 1009;
export const VIEWER_CLOSE_INTERNAL = 1011;

/** A viewer that may only watch tried to type: the host refuses the input and the stream ends on a policy close. */
export class ViewerInputRefused extends Error {
  constructor() {
    super('this viewer may watch the page, not type into it');
    this.name = 'ViewerInputRefused';
  }
}
