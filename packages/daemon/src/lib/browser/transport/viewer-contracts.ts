import type { BrowserInputEvent, BrowserScreencastFrame } from '@ferretry/protocol';

/** A viewer's socket, seen from the domain: one binary envelope out, a close code at the end. */
export interface ViewerDownstream {
  /** `0` means the transport dropped the message; anything else (including nothing) is accepted. */
  send(envelope: Uint8Array): number | void;
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

export interface ViewerStreamOptions {
  /** Largest single client message accepted before the stream is a protocol violation. */
  readonly maxInputMessageBytes?: number;
  /** Total in-flight client bytes tolerated before the client is judged to be flooding. */
  readonly maxQueuedInputBytes?: number;
  /** Buffered downstream bytes above which a frame waits instead of being queued behind others. */
  readonly maxBufferedBytes?: number;
  /** How often a retained frame retries while the transport is congested. */
  readonly recoveryPollMs?: number;
}

/** WebSocket close codes the transport uses, named so call sites read as decisions. */
export const VIEWER_CLOSE_NORMAL = 1000;
export const VIEWER_CLOSE_POLICY = 1008;
export const VIEWER_CLOSE_TOO_LARGE = 1009;
export const VIEWER_CLOSE_INTERNAL = 1011;
