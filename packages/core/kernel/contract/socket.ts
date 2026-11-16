import type { ApiResponse } from './http.ts';
import type { CallContext, CallStanding, ScopedRoute } from './route.ts';

export type SocketFrame = string | ArrayBuffer | ArrayBufferView;

export const SOCKET_MAX_FRAME_BYTES = 64 * 1024;
export const SOCKET_MAX_PENDING_FRAMES = 16;

export const SOCKET_CLOSES = {
  handshakeOverflow: { code: 1009, reason: 'socket handshake queue exceeded' },
  unavailable: { code: 1011, reason: 'socket handler unavailable' },
  shuttingDown: { code: 1000, reason: 'daemon shutting down' },
  /** A provider of this caller's kind went away, or its standing changed (§7.1 fail-closed lifecycle). */
  unauthorized: { code: 4401, reason: 'this session is no longer admitted' },
} as const;

export type SocketClose = (typeof SOCKET_CLOSES)[keyof typeof SOCKET_CLOSES];

/**
 * The downstream a socket handler writes to. `permit` is the per-frame final check (§7.3): true while what the frame
 * shows may still be shown, asked again by the kernel immediately before the socket write.
 */
export interface SocketDownstream {
  send(frame: string | Uint8Array, permit?: () => boolean): number | undefined;
  close(code: number, reason: string): void;
  bufferedBytes(): number;
}

export interface SocketEnded {
  readonly code: number;
  readonly reason: string;
}

export interface SocketHandler {
  open(): Promise<void>;
  fromClient(frame: SocketFrame): void;
  close(ended?: SocketEnded): void;
}

export type SocketAttachment = (downstream: SocketDownstream) => Promise<SocketHandler>;

export type SocketAccept<Standing extends object = CallStanding> = (
  call: CallContext<Standing>,
) => Promise<SocketAttachment>;

/** What a manifest declares for one socket: the full descriptor, no handler. */
export interface SocketDescriptor extends ScopedRoute {}

export interface SocketRoute<Standing extends object = CallStanding> extends SocketDescriptor {
  accept: SocketAccept<Standing>;
}

export type SocketUpgradeDecision =
  | { readonly outcome: 'accepted'; readonly attach: SocketAttachment }
  | { readonly outcome: 'unclaimed' }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };
