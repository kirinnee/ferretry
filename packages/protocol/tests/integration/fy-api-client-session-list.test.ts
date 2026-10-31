import { describe, it } from 'bun:test';
import should from 'should';
import { FyHttpError } from '../../src/adapters/fy-api-client.ts';
import { sessionView } from '../fixtures.ts';
import { BASE_URL, connectClient, headersOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

/**
 * The fleet read is conditional: the client holds the last list and its tag, sends the tag back, and
 * turns a bodyless `304` into the list it holds (shared and frozen: see session-list-sharing.test.ts).
 * What can break is the header sent, the list a `304` stands for, and an overlapping read leaving an
 * older list held.
 */

const RENAMED = { ...sessionView, config: { ...sessionView.config, name: 'Renamed' } };
const tagged = (value: unknown, etag: string): Response => jsonResponse(value, { headers: { etag } });
const notModified = (etag: string): Response => new Response(null, { status: 304, headers: { etag } });

describe('FyApiClient conditional fleet reads', () => {
  it('should send no validator first, then the tag it was given, and answer a 304 with the held list', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged([sessionView], '"f1"'), notModified('"f1"'));
    const client = await connectClient(transport);

    // Act
    const first = await client.list();
    const second = await client.list();

    // Assert
    should(first).deepEqual([sessionView]);
    should(second).deepEqual([sessionView]);
    should(headersOf(transport, 0).has('if-none-match')).be.false();
    should(headersOf(transport, 1).get('if-none-match')).equal('"f1"');
    should(transport.calls[1]?.url).equal(`${BASE_URL}/v1/sessions`);
  });

  it('should replace the held list when the fleet moved on', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      tagged([sessionView], '"f1"'),
      tagged([RENAMED], '"f2"'),
      notModified('"f2"'),
    );
    const client = await connectClient(transport);

    // Act
    await client.list();
    const moved = await client.list();
    const held = await client.list();

    // Assert
    should(moved).deepEqual([RENAMED]);
    should(held).deepEqual([RENAMED]);
    should(headersOf(transport, 2).get('if-none-match')).equal('"f2"');
  });

  it('should hold nothing for an answer from a daemon that predates the tag', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      tagged([sessionView], '"f1"'),
      jsonResponse([RENAMED]),
      jsonResponse([RENAMED]),
    );
    const client = await connectClient(transport);

    // Act
    await client.list();
    await client.list();
    const third = await client.list();

    // Assert
    should(third).deepEqual([RENAMED]);
    should(headersOf(transport, 1).get('if-none-match')).equal('"f1"');
    should(headersOf(transport, 2).has('if-none-match')).be.false();
  });

  it('should keep the newer list when a 304 for an older tag lands after it', async () => {
    // Arrange: the first conditional read is still in flight while a second one learns the fleet moved.
    const transport = new QueuedHttpTransport(tagged([sessionView], '"f1"'));
    const client = await connectClient(transport);
    await client.list();
    let overlapped: unknown;
    transport.enqueue(async () => {
      transport.enqueue(tagged([RENAMED], '"f2"'));
      overlapped = await client.list();
      return notModified('"f1"');
    });

    // Act
    const late = await client.list();
    transport.enqueue(notModified('"f2"'));
    const after = await client.list();

    // Assert
    should(overlapped).deepEqual([RENAMED]);
    should(late).deepEqual([sessionView]);
    should(after).deepEqual([RENAMED]);
    should(headersOf(transport, transport.calls.length - 1).get('if-none-match')).equal('"f2"');
  });

  it('should refuse a 304 it sent no validator for rather than read it as an empty fleet', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(notModified('"f1"'));
    const client = await connectClient(transport);

    // Act
    const error = await captureError(() => client.list());

    // Assert
    should(error).be.instanceOf(FyHttpError);
    should((error as FyHttpError).status).equal(304);
  });
});
