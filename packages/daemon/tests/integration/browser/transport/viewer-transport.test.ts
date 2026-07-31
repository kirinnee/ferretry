import { describe, it } from 'bun:test';
import should from 'should';
import type { BrowserInputEvent, BrowserScreencastFrame } from '@ferretry/protocol';
import { SocketViewerDownstream, SystemFrameClock, type ViewerSocket } from '../../../../src/adapters/index.ts';
import {
  BrowserViewerStream,
  type BrowserViewerHost,
  type ViewerAttachment,
  decodeFrameEnvelope,
} from '../../../../src/lib/index.ts';

class FakeSocket implements ViewerSocket {
  sent: Array<{ readonly bytes: Uint8Array; readonly compress?: boolean }> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;
  result = 1;
  buffered?: number;

  send(data: Uint8Array, compress?: boolean): number {
    this.sent.push({ bytes: data, ...(compress === undefined ? {} : { compress }) });
    return this.result;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  getBufferedAmount(): number {
    if (this.buffered === undefined) throw new Error('this socket cannot report buffering');
    return this.buffered;
  }
}

/** A socket that predates backpressure reporting, to prove the port tolerates its absence. */
class MinimalSocket implements ViewerSocket {
  readyState = 1;
  sent = 0;

  send(): number {
    this.sent += 1;
    return 1;
  }

  close(): void {
    // Nothing to record: this socket exists to prove the optional members are optional.
  }
}

class RecordingHost implements BrowserViewerHost {
  dispatched: BrowserInputEvent[] = [];
  publish?: (frame: BrowserScreencastFrame) => void;

  attachViewer(_sessionId: string, onFrame: (frame: BrowserScreencastFrame) => void): Promise<ViewerAttachment> {
    this.publish = onFrame;
    return Promise.resolve({ detach: () => undefined });
  }

  dispatchHumanInput(_sessionId: string, input: BrowserInputEvent): Promise<void> {
    this.dispatched.push(input);
    return Promise.resolve();
  }
}

describe('system frame clock', () => {
  it('should report wall-clock time and fire a scheduled callback', async () => {
    // Arrange
    const clock = new SystemFrameClock();
    const before = Date.now();
    let fired = 0;

    // Act
    const elapsed = clock.now() - before;
    clock.schedule(() => {
      fired += 1;
    }, 5);
    await Bun.sleep(30);

    // Assert
    should(elapsed).be.aboveOrEqual(0);
    should(elapsed).be.below(1_000);
    should(fired).equal(1);
  });

  it('should not fire a cancelled timer', async () => {
    // Arrange
    const clock = new SystemFrameClock();
    let fired = 0;

    // Act
    clock
      .schedule(() => {
        fired += 1;
      }, 5)
      .cancel();
    await Bun.sleep(30);

    // Assert
    should(fired).equal(0);
  });
});

describe('socket viewer downstream', () => {
  it('should send frames uncompressed and report the transport result', () => {
    // Arrange
    const socket = new FakeSocket();
    socket.result = -1;
    const downstream = new SocketViewerDownstream(socket);

    // Act
    const result = downstream.send(Uint8Array.of(1, 2, 3));

    // Assert: JPEG bytes are already compressed, so asking the socket to do it again is waste.
    should(result).equal(-1);
    should(socket.sent).have.length(1);
    should(socket.sent[0]?.compress).be.false();
  });

  it('should report a frame as dropped rather than throwing on a socket that is not open', () => {
    // Arrange
    const socket = new FakeSocket();
    socket.readyState = 2;
    const downstream = new SocketViewerDownstream(socket);

    // Act
    const result = downstream.send(Uint8Array.of(9));

    // Assert: the newest frame is retained for the recovery poll instead of ending the stream.
    should(result).equal(0);
    should(socket.sent).be.empty();
  });

  it('should forward the close code and reason', () => {
    // Arrange
    const socket = new FakeSocket();

    // Act
    new SocketViewerDownstream(socket).close(1009, 'browser frame exceeded');

    // Assert
    should(socket.closes).deepEqual([{ code: 1009, reason: 'browser frame exceeded' }]);
  });

  it('should report buffered bytes, and zero for a socket that cannot', () => {
    // Arrange
    const reporting = new FakeSocket();
    reporting.buffered = 4_096;

    // Act & Assert
    should(new SocketViewerDownstream(reporting).bufferedBytes()).equal(4_096);
    should(new SocketViewerDownstream(new MinimalSocket()).bufferedBytes()).equal(0);
  });
});

describe('viewer stream over a real socket adapter', () => {
  it('should place a captured frame on the socket as one decodable envelope', async () => {
    // Arrange
    const host = new RecordingHost();
    const socket = new FakeSocket();
    socket.buffered = 0;
    const stream = await BrowserViewerStream.connect(
      host,
      'session-1',
      new SocketViewerDownstream(socket),
      new SystemFrameClock(),
    );

    // Act
    host.publish?.({ dataBase64: btoa('jpeg'), width: 800, height: 600, pageId: 'page-7' });
    stream.fromClient(JSON.stringify({ kind: 'insertText', text: 'typed' }));
    await stream.settled;

    // Assert
    should(socket.sent).have.length(1);
    const decoded = decodeFrameEnvelope(socket.sent[0]?.bytes ?? Uint8Array.of());
    should(decoded.ok && decoded.value.pageId).equal('page-7');
    should(host.dispatched).deepEqual([{ kind: 'insertText', text: 'typed' }]);

    // Act
    stream.close();

    // Assert: a viewer that vanished gets no close frame on a socket it already left.
    should(socket.closes).be.empty();
  });

  it('should retry a dropped frame on the real timer until the socket accepts it', async () => {
    // Arrange
    const host = new RecordingHost();
    const socket = new FakeSocket();
    socket.buffered = 0;
    socket.result = 0;
    await BrowserViewerStream.connect(host, 'session-1', new SocketViewerDownstream(socket), new SystemFrameClock(), {
      recoveryPollMs: 5,
    });

    // Act
    host.publish?.({ dataBase64: btoa('jpeg'), width: 800, height: 600, pageId: 'page-7' });
    socket.result = 1;
    await Bun.sleep(40);

    // Assert
    should(socket.sent.length).be.aboveOrEqual(2);
  });
});
