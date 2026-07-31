import type { ViewerDownstream } from '../../../lib/index.ts';

/**
 * The subset of a server WebSocket the transport needs. Bun's socket reports `0` when it dropped a
 * message and a negative number when it accepted one under backpressure.
 */
export interface ViewerSocket {
  send(data: Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  getBufferedAmount?(): number;
}

const OPEN = 1;

/** Adapts one live viewer socket to the domain's downstream port. */
export class SocketViewerDownstream implements ViewerDownstream {
  constructor(private readonly socket: ViewerSocket) {}

  send(envelope: Uint8Array): number | void {
    // A socket that is not open would throw on send; report it as dropped so the newest frame is
    // retained for the recovery poll instead of ending an otherwise healthy stream.
    if (this.socket.readyState !== OPEN) return 0;
    // Frames are JPEG bytes: compressing them again costs CPU and gains nothing.
    return this.socket.send(envelope, false);
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  bufferedBytes(): number {
    return this.socket.getBufferedAmount?.() ?? 0;
  }
}
