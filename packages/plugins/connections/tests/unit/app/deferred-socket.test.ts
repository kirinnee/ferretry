/**
 * A socket whose WebRTC channel is still being negotiated (`app/carriers/deferred-socket.ts`): the walk takes it at once,
 * it adopts the channel when the dial resolves, ends with the dial's sentence when it rejects, and is abandoned (not the
 * peer connection under a channel in use) when it is closed first.
 */
import { describe, expect, test } from 'bun:test';
import type { RelayCarrierSocket } from '../../../app/adapters/browser-relay-dial.ts';
import { deferredSocket } from '../../../app/carriers/deferred-socket.ts';

/** A channel that records what it was asked, and lets a test speak as the daemon. */
function channel() {
  const log: string[] = [];
  const socket: RelayCarrierSocket = {
    onOpen: null,
    onText: null,
    onBinary: null,
    onClose: null,
    send: bytes => void log.push(`send ${String(bytes.length)}`),
    sendText: text => void log.push(`text ${text}`),
    close: (code, reason) => void log.push(`close ${String(code)} ${String(reason)}`),
  };
  return { socket, log };
}

/** A dial the test settles by hand. */
function pendingDial() {
  let resolve: (socket: RelayCarrierSocket) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const dial = new Promise<RelayCarrierSocket>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { dial, resolve, reject };
}

const turn = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('a socket still negotiating its channel', () => {
  test('R677 it carries the channel’s open, text, bytes and close to the handlers the walk installed, and writes to it', async () => {
    const pending = pendingDial();
    const seen: string[] = [];
    const socket = deferredSocket(pending.dial, () => seen.push('abandoned'));
    socket.onOpen = () => void seen.push('open');
    socket.onText = text => void seen.push(`text ${text}`);
    socket.onBinary = bytes => void seen.push(`bytes ${String(bytes.length)}`);
    socket.onClose = (code, reason) => void seen.push(`close ${String(code)} ${reason}`);
    // Written to before the channel exists: nothing to write to yet, and nothing breaks.
    socket.send(new Uint8Array(2));
    socket.sendText('early');

    const live = channel();
    pending.resolve(live.socket);
    await turn();
    live.socket.onOpen?.();
    live.socket.onText?.('hello');
    live.socket.onBinary?.(new Uint8Array(3));
    socket.send(new Uint8Array(4));
    socket.sendText('later');
    live.socket.onClose?.(1006, 'the peer-to-peer channel closed');

    expect(seen).toEqual(['open', 'text hello', 'bytes 3', 'close 1006 the peer-to-peer channel closed']);
    expect(live.log).toEqual(['send 4', 'text later']);
  });

  test('R677 a dial that fails ends the socket with the sentence it gave, as a refused connection ends', async () => {
    const pending = pendingDial();
    const closes: string[] = [];
    const socket = deferredSocket(pending.dial, () => undefined);
    socket.onClose = (code, reason) => void closes.push(`${String(code)} ${reason}`);

    pending.reject(new Error('no direct path found in 8 s'));
    await turn();
    // A close after the end is nothing more to say.
    socket.close(1000, 'late');

    expect(closes).toEqual(['1006 no direct path found in 8 s']);
  });

  test('R677 a failure that is not an Error is still said, as text', async () => {
    const pending = pendingDial();
    const closes: string[] = [];
    deferredSocket(pending.dial, () => undefined).onClose = (_code, reason) => void closes.push(reason);
    const again = deferredSocket(Promise.reject('plain refusal'), () => undefined);
    again.onClose = (_code, reason) => void closes.push(reason);

    await turn();

    expect(closes).toEqual(['plain refusal']);
  });

  test('R677 closing before the channel exists abandons the negotiation, and a channel that arrives after is closed unused', async () => {
    const pending = pendingDial();
    const abandoned: string[] = [];
    const closes: string[] = [];
    const socket = deferredSocket(pending.dial, () => void abandoned.push('abandon'));
    socket.onClose = () => void closes.push('closed');

    socket.close(1000, 'deadline');
    socket.close(1000, 'again');
    const live = channel();
    pending.resolve(live.socket);
    await turn();

    expect(abandoned).toEqual(['abandon']);
    expect(live.log).toEqual(['close undefined undefined']);
    expect(closes).toEqual([]);
    // A dial that fails after the walk gave up says nothing to anybody.
    const late = pendingDial();
    const quiet = deferredSocket(late.dial, () => undefined);
    quiet.onClose = () => void closes.push('late failure');
    quiet.close();
    late.reject(new Error('too late'));
    await turn();
    expect(closes).toEqual([]);
  });

  test('R677 closing once the channel is open ends that channel only, never the peer connection under it', async () => {
    const pending = pendingDial();
    const abandoned: string[] = [];
    const socket = deferredSocket(pending.dial, () => void abandoned.push('abandon'));
    const live = channel();
    pending.resolve(live.socket);
    await turn();

    socket.close(1000, 'done');
    socket.close(1000, 'again');

    expect(live.log).toEqual(['close 1000 done']);
    expect(abandoned).toEqual([]);
  });
});
