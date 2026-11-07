import { describe, it } from 'bun:test';
import should from 'should';
import { ZodError } from 'zod';
import type { SessionView } from '../../src/lib/session.ts';
import { sessionView } from '../fixtures.ts';
import { connectClient, headersOf } from '../integration/client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from '../integration/fakes.ts';

/**
 * The fleet list is parsed once at the boundary and then shared: a `304` answers the very list the
 * full read parsed, frozen, instead of a deep copy per read. What can break is a copy sneaking back, a
 * reader changing the held list, a change made elsewhere not showing on the next read, and a malformed
 * session getting past the schema.
 */

const RENAMED = { ...sessionView, config: { ...sessionView.config, name: 'Renamed' } };
const tagged = (value: unknown, etag: string): Response => jsonResponse(value, { headers: { etag } });
const notModified = (etag: string): Response => new Response(null, { status: 304, headers: { etag } });
const captureThrown = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('FyApiClient shared fleet list', () => {
  it('should answer a 304 with the very list the full read parsed, not a copy of it', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged([sessionView], '"f1"'), notModified('"f1"'), notModified('"f1"'));
    const client = await connectClient(transport);

    // Act
    const first = await client.list();
    const second = await client.list();
    const third = await client.list();

    // Assert
    should(second).equal(first);
    should(third).equal(first);
    should(third[0]).equal(first[0]);
  });

  it('should refuse to let a caller change the held list through what it was given', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged([sessionView], '"f1"'), notModified('"f1"'), notModified('"f1"'));
    const client = await connectClient(transport);
    const first = await client.list();
    const second = await client.list();

    // Act
    const dropped = captureThrown(() => (first as SessionView[]).pop());
    const renamed = captureThrown(() => {
      (second[0] as SessionView).config.name = 'Changed';
    });
    const flagged = captureThrown(() => (second[0] as SessionView).config.harnessFlags.push('--changed'));
    const third = await client.list();

    // Assert
    should(dropped).be.instanceOf(TypeError);
    should(renamed).be.instanceOf(TypeError);
    should(flagged).be.instanceOf(TypeError);
    should(third).deepEqual([sessionView]);
  });

  it('should see an external change on the next read, because every read asks the daemon with the held tag', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged([sessionView], '"f1"'), tagged([RENAMED], '"f2"'));
    const client = await connectClient(transport);

    // Act
    const before = await client.list();
    const after = await client.list();

    // Assert
    should(headersOf(transport, 1).get('if-none-match')).equal('"f1"');
    should(before).deepEqual([sessionView]);
    should(after).deepEqual([RENAMED]);
  });

  it('should reject a malformed session at the boundary and keep the list it already held', async () => {
    // Arrange: the second answer carries one entry with no state, among good ones.
    const broken = { ...RENAMED, state: undefined };
    const transport = new QueuedHttpTransport(
      tagged([sessionView], '"f1"'),
      tagged([sessionView, broken], '"f2"'),
      notModified('"f1"'),
    );
    const client = await connectClient(transport);
    const held = await client.list();

    // Act
    const error = await captureError(() => client.list());
    const after = await client.list();

    // Assert
    should(error).be.instanceOf(ZodError);
    should(after).equal(held);
    should(headersOf(transport, 2).get('if-none-match')).equal('"f1"');
  });
});
