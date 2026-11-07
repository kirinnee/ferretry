import { describe, it } from 'bun:test';
import should from 'should';
import {
  CDP_PIPE_ENDPOINT,
  CDP_PIPE_FROM_CHROME_FD,
  CDP_PIPE_TO_CHROME_FD,
  CdpPipeTransport,
  type CdpPipeWriter,
} from '../../../../src/lib/index.ts';

/** The worker's end of Chrome's fd 3, recorded: what was written, and whether it was ended. */
class RecordingWriter implements CdpPipeWriter {
  readonly written: string[] = [];
  closes = 0;
  write(bytes: string): void {
    this.written.push(bytes);
  }
  close(): void {
    this.closes += 1;
  }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function connected(maxMessageChars?: number): {
  readonly transport: CdpPipeTransport;
  readonly writer: RecordingWriter;
  readonly messages: object[];
  readonly closes: (string | undefined)[];
} {
  const writer = new RecordingWriter();
  const transport = new CdpPipeTransport(writer, maxMessageChars);
  const messages: object[] = [];
  const closes: (string | undefined)[] = [];
  transport.onmessage = message => messages.push(message);
  transport.onclose = reason => closes.push(reason);
  return { transport, writer, messages, closes };
}

describe('CdpPipeTransport', () => {
  it('should name the pipe the way Chrome numbers it: the worker writes on 3 and reads on 4', () => {
    should({ endpoint: CDP_PIPE_ENDPOINT, toChrome: CDP_PIPE_TO_CHROME_FD, fromChrome: CDP_PIPE_FROM_CHROME_FD }).eql({
      endpoint: 'pipe',
      toChrome: 3,
      fromChrome: 4,
    });
  });

  it('should send each request as one JSON object followed by a NUL', () => {
    const { transport, writer } = connected();

    transport.send({ id: 1, method: 'Browser.getVersion' });
    transport.send({ id: 2, method: 'Target.setDiscoverTargets', params: { discover: true } });

    should(writer.written).deepEqual([
      '{"id":1,"method":"Browser.getVersion"}\0',
      '{"id":2,"method":"Target.setDiscoverTargets","params":{"discover":true}}\0',
    ]);
  });

  it('should deliver a message split across chunks, and several messages in one chunk, in order', () => {
    const { transport, messages } = connected();

    transport.receive(bytes('{"id":1,"res'));
    transport.receive(bytes('ult":{}}\0{"method":"Target.attachedToTarget"}\0{"id":'));
    transport.receive(bytes('2}\0'));

    should(messages).deepEqual([{ id: 1, result: {} }, { method: 'Target.attachedToTarget' }, { id: 2 }]);
  });

  it('should keep a multi-byte character whole when a chunk boundary cuts through it', () => {
    const { transport, messages } = connected();
    const encoded = bytes('{"title":"héllo ☕"}\0');
    const cut = encoded.indexOf(0xe2) + 1;

    transport.receive(encoded.slice(0, cut));
    transport.receive(encoded.slice(cut));

    should(messages).deepEqual([{ title: 'héllo ☕' }]);
  });

  it('should end the connection on a message that is not a JSON object, and read nothing after it', () => {
    for (const record of ['not json', '[1,2]', 'null']) {
      const { transport, writer, messages, closes } = connected();

      transport.receive(bytes(`{"id":1}\0${record}\0{"id":2}\0`));
      transport.receive(bytes('{"id":3}\0'));

      should(messages).deepEqual([{ id: 1 }]);
      should(closes).deepEqual(['Chrome sent a DevTools message that is not a JSON object']);
      // Ending the read side ends the write side too: Chrome sees end-of-file and shuts down.
      should(writer.closes).equal(1);
    }
  });

  it('should end the connection when one message outgrows the ceiling instead of buffering it forever', () => {
    const { transport, messages, closes } = connected(8);

    transport.receive(bytes('{"id":1}\0'));
    transport.receive(bytes('{"id":12345'));

    should(messages).deepEqual([{ id: 1 }]);
    should(closes).deepEqual(['Chrome sent an oversized DevTools message']);
  });

  it('should close the write side once, and drop requests sent after it', () => {
    const { transport, writer, closes } = connected();

    transport.close();
    transport.close();
    transport.send({ id: 9, method: 'Browser.close' });

    should(writer.closes).equal(1);
    should(writer.written).deepEqual([]);
    // Closing what the worker SENDS is not the connection ending: that is Chrome closing its own end.
    should(closes).deepEqual([]);
  });

  it('should keep reading after its own close, until Chrome closes its end', () => {
    const { transport, messages, closes } = connected();

    transport.close();
    transport.receive(bytes('{"id":1,"result":{}}\0'));
    transport.ended();
    transport.ended('a second end is not news');
    transport.receive(bytes('{"id":2}\0'));

    should(messages).deepEqual([{ id: 1, result: {} }]);
    should(closes).deepEqual([undefined]);
  });

  it('should report why the read side broke, and work with no listeners at all', () => {
    const { transport, closes } = connected();
    const silent = new CdpPipeTransport(new RecordingWriter());

    transport.ended('EIO');
    silent.receive(bytes('{"id":1}\0'));
    silent.ended();

    should(closes).deepEqual(['EIO']);
  });
});
