import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { FyHttpError } from '../../src/adapters/fy-api-client.ts';
import { BASE_URL, connectClient, headersOf } from './client-harness.ts';
import { captureError, QueuedHttpTransport, textResponse } from './fakes.ts';

/**
 * The transcript read is conditional: the client holds the last body and tag per read path, sends the
 * tag back, and turns a bodyless `304` into the body it already holds. What can break is the header
 * sent, the body a `304` stands for, and the bound on what is held.
 */

const tagged = (body: string, etag: string): Response => textResponse(body, { headers: { etag } });
const notModified = (etag: string): Response => new Response(null, { status: 304, headers: { etag } });

describe('FyApiClient conditional transcript reads', () => {
  it('should send no validator first, then the tag it was given, and answer a 304 with the held body', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged('the transcript', '"t1"'), notModified('"t1"'));
    const client = await connectClient(transport);

    // Act
    const first = await client.logs('session-1');
    const second = await client.logs('session-1');

    // Assert
    should(first).equal('the transcript');
    should(second).equal('the transcript');
    should(headersOf(transport, 0).has('if-none-match')).be.false();
    should(headersOf(transport, 1).get('if-none-match')).equal('"t1"');
    should(transport.calls[1]?.url).equal(`${BASE_URL}/v1/sessions/session-1/logs`);
  });

  it('should replace the held body when the transcript moved on', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      tagged('the transcript', '"t1"'),
      tagged('the transcript, and more', '"t2"'),
      notModified('"t2"'),
    );
    const client = await connectClient(transport);

    // Act
    await client.logs('session-1');
    const moved = await client.logs('session-1');
    const held = await client.logs('session-1');

    // Assert
    should(moved).equal('the transcript, and more');
    should(held).equal('the transcript, and more');
    should(headersOf(transport, 2).get('if-none-match')).equal('"t2"');
  });

  it('should hold nothing for an answer that carried no tag', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      tagged('the transcript', '"t1"'),
      textResponse('from an older daemon'),
      textResponse('from an older daemon'),
    );
    const client = await connectClient(transport);

    // Act
    await client.logs('session-1');
    await client.logs('session-1');
    await client.logs('session-1');

    // Assert
    should(headersOf(transport, 1).get('if-none-match')).equal('"t1"');
    should(headersOf(transport, 2).has('if-none-match')).be.false();
  });

  it('should keep a turn read apart from the whole tail', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged('the tail', '"tail"'), tagged('turn zero', '"turn"'));
    const client = await connectClient(transport);

    // Act
    await client.logs('session-1');
    const turn = await client.logs('session-1', 0);

    // Assert
    should(turn).equal('turn zero');
    should(headersOf(transport, 1).has('if-none-match')).be.false();
  });

  it('should refuse a 304 it sent no validator for rather than read it as an empty transcript', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(notModified('"t1"'), notModified('"t1"'));
    const client = await connectClient(transport);

    // Act
    const logsError = await captureError(() => client.logs('session-1'));
    const requestError = await captureError(() => client.request('/v1/anything', z.string()));

    // Assert
    should(logsError).be.instanceOf(FyHttpError);
    should((logsError as FyHttpError).status).equal(304);
    should(requestError).be.instanceOf(FyHttpError);
  });

  it('should forget the least recently read session past its bound, and a 304 counts as a read', async () => {
    // Arrange
    const sessions = Array.from({ length: 17 }, (_, index) => `session-${index}`);
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    for (const session of sessions.slice(0, 16)) {
      transport.enqueue(tagged(`said by ${session}`, `"${session}"`));
      await client.logs(session);
    }
    transport.enqueue(notModified('"session-0"'));
    await client.logs('session-0');

    // Act
    transport.enqueue(tagged('said by session-16', '"session-16"'), notModified('"session-0"'));
    transport.enqueue(tagged('said by session-1', '"session-1b"'));
    await client.logs('session-16');
    const kept = await client.logs('session-0');
    await client.logs('session-1');

    // Assert
    should(kept).equal('said by session-0');
    should(headersOf(transport, transport.calls.length - 2).get('if-none-match')).equal('"session-0"');
    should(headersOf(transport, transport.calls.length - 1).has('if-none-match')).be.false();
  });

  it('should answer a 304 with the body held when it was sent, even if that entry was evicted meanwhile', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged('the transcript', '"t1"'));
    const client = await connectClient(transport);
    await client.logs('session-1');
    transport.enqueue(async () => {
      for (let index = 0; index < 16; index++) {
        transport.enqueue(tagged(`other ${index}`, `"o${index}"`));
        await client.logs(`other-${index}`);
      }
      return notModified('"t1"');
    });

    // Act
    const answered = await client.logs('session-1');

    // Assert
    should(answered).equal('the transcript');
  });
});
