import { describe, it } from 'bun:test';
import should from 'should';
import type { SocketDownstream } from '../../../src/lib/api/socket.ts';
import {
  CONFIG_STREAM_CLOSES,
  ConfigChangeLedger,
  ConfigChangeStreamService,
} from '../../../src/lib/config-files/index.ts';
import { EVENT_STREAM_IDLE_MS, EVENT_STREAM_MAX_BUFFER_BYTES } from '../../../src/lib/session/events/index.ts';

/** Timers a test fires by hand; a cancelled one never fires. */
class ManualTimers {
  readonly armed: { readonly milliseconds: number; readonly action: () => void; cancelled: boolean }[] = [];

  after(milliseconds: number, action: () => void) {
    const entry = { milliseconds, action, cancelled: false };
    this.armed.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  /** Fire every live timer armed so far. */
  fire(): void {
    for (const entry of this.armed.splice(0)) if (!entry.cancelled) entry.action();
  }

  live(): number {
    return this.armed.filter(entry => !entry.cancelled).length;
  }
}

class RecordingSocket implements SocketDownstream {
  readonly frames: unknown[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];
  buffered = 0;
  answer: number | undefined = 1;
  throws = false;

  send(frame: string | Uint8Array): number | undefined {
    if (this.throws) throw new Error('the socket is gone');
    this.frames.push(JSON.parse(String(frame)));
    return this.answer;
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }

  bufferedBytes(): number {
    return this.buffered;
  }
}

const setup = () => {
  const ledgerTimers = new ManualTimers();
  const streamTimers = new ManualTimers();
  const ledger = new ConfigChangeLedger('boot-7', ledgerTimers);
  const service = new ConfigChangeStreamService(ledger, streamTimers);
  const socket = new RecordingSocket();
  const handler = service.handler(socket);
  return { ledger, ledgerTimers, streamTimers, socket, handler };
};

describe('the configuration stream', () => {
  it('should open with where the revision stands, naming no kinds', async () => {
    // Arrange
    const { ledger, ledgerTimers, socket, handler } = setup();
    ledger.announce(['runtimes']);
    ledgerTimers.fire();

    // Act
    await handler.open();

    // Assert — a reader that saw revision 0 before it was disconnected now knows it missed one.
    should(socket.frames).deepEqual([{ kind: 'config', epoch: 'boot-7', revision: 1, kinds: [] }]);
  });

  it('should send every counted change as it happens, and nothing after it closed', async () => {
    // Arrange
    const { ledger, ledgerTimers, socket, handler } = setup();
    await handler.open();

    // Act
    ledger.announce(['credentials', 'runtimes']);
    ledgerTimers.fire();
    handler.close();
    handler.close();
    ledger.announce(['warden']);
    ledgerTimers.fire();

    // Assert
    should(socket.frames.slice(1)).deepEqual([
      { kind: 'config', epoch: 'boot-7', revision: 1, kinds: ['credentials', 'runtimes'] },
    ]);
  });

  it('should prove a quiet stream is alive every window, not once', async () => {
    // Arrange
    const { streamTimers, socket, handler } = setup();
    await handler.open();

    // Act
    streamTimers.fire();
    streamTimers.fire();

    // Assert
    should(streamTimers.armed[0]?.milliseconds).equal(EVENT_STREAM_IDLE_MS);
    should(socket.frames.slice(1)).deepEqual([
      { kind: 'idle', epoch: 'boot-7', revision: 0, idleSeconds: EVENT_STREAM_IDLE_MS / 1_000 },
      { kind: 'idle', epoch: 'boot-7', revision: 0, idleSeconds: EVENT_STREAM_IDLE_MS / 1_000 },
    ]);
    handler.close();
    should(streamTimers.live()).equal(0);
  });

  it('should open nothing for a socket closed before it opened', async () => {
    // Arrange
    const { socket, handler, streamTimers } = setup();
    handler.close();

    // Act
    await handler.open();

    // Assert
    should(socket.frames).be.empty();
    should(streamTimers.live()).equal(0);
  });

  it('should close a reader that fell behind, with the slow-reader code', async () => {
    // Arrange
    const { socket, handler } = setup();
    socket.buffered = EVENT_STREAM_MAX_BUFFER_BYTES + 1;

    // Act
    await handler.open();

    // Assert
    should(socket.frames).be.empty();
    should(socket.closes).deepEqual([CONFIG_STREAM_CLOSES.slowReader]);
  });

  it('should stop at a socket that refused or threw on a write', async () => {
    // Arrange
    const refused = setup();
    refused.socket.answer = -1;
    const thrown = setup();
    thrown.socket.throws = true;

    // Act
    await refused.handler.open();
    await thrown.handler.open();

    // Assert — the peer is gone; there is nobody to send a close code to, and no timer is left.
    should(refused.streamTimers.live()).equal(0);
    should(thrown.streamTimers.live()).equal(0);
    should(refused.socket.closes).be.empty();
  });

  it('should refuse a frame from the client', async () => {
    // Arrange
    const { socket, handler } = setup();
    await handler.open();

    // Act
    handler.fromClient('hello');

    // Assert
    should(socket.closes).deepEqual([CONFIG_STREAM_CLOSES.clientFrame]);
  });
});
