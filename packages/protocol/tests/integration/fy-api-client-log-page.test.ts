import { describe, it } from 'bun:test';
import should from 'should';
import { BASE_URL, connectClient, headersOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

/**
 * A page of the chat's transcript: the tail, or the page before a byte. Conditional like `logs`, so a
 * polled tail that has not moved is a `304` that answers the page already held, and each page is its
 * own path so an older page never stands in for the tail.
 */

const PAGE = { v: 1, sessionId: 'session-1', log: 'user/message: hi', start: 400, file: 'f1' } as const;
const tagged = (body: unknown, etag: string): Response => jsonResponse(body, { headers: { etag } });
const notModified = (etag: string): Response => new Response(null, { status: 304, headers: { etag } });

describe('FyApiClient log pages', () => {
  it('should read the tail with no query, and answer a 304 with the page it holds', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(tagged(PAGE, '"p1"'), notModified('"p1"'));
    const client = await connectClient(transport);

    // Act
    const first = await client.logPage('session-1');
    const second = await client.logPage('session-1');

    // Assert
    should(first).eql(PAGE);
    should(second).eql(PAGE);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/session-1/log-page`);
    should(headersOf(transport, 1).get('if-none-match')).equal('"p1"');
  });

  it('should name the page before a byte, its floor, its size and its file in the query', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse({ ...PAGE, start: 0 }));
    const client = await connectClient(transport);

    // Act
    const page = await client.logPage('session-1', { before: 400, from: 100, limit: 50, file: 'f1' });

    // Assert
    should(page.start).equal(0);
    should(transport.calls[0]?.url).equal(
      `${BASE_URL}/v1/sessions/session-1/log-page?before=400&from=100&limit=50&file=f1`,
    );
  });

  it('should hold nothing for an answer that carried no tag', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(PAGE), jsonResponse(PAGE));
    const client = await connectClient(transport);

    // Act
    await client.logPage('session-1');
    await client.logPage('session-1');

    // Assert
    should(headersOf(transport, 1).has('if-none-match')).be.false();
  });

  it('should refuse a position that is not a byte of a file before asking', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const error = await captureError(() => client.logPage('session-1', { before: -1 }));

    // Assert
    should(error).be.instanceOf(Error);
    should(transport.calls).have.length(0);
  });
});
