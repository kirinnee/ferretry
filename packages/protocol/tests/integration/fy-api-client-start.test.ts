import { describe, it } from 'bun:test';
import should from 'should';
import { FyHttpError, FyTransportError } from '../../src/adapters/fy-api-client.ts';
import type { StartSessionRequestInput } from '../../src/lib/session.ts';
import { sessionView, taskBoardGrantRequestView } from '../fixtures.ts';
import { BASE_URL, connectClient, headersOf, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

const START_INPUT = {
  agent: 'claude-auto-loge',
  mode: 'auto',
  prompt: 'ship it',
} satisfies StartSessionRequestInput;

const BOARD_START_INPUT = {
  agent: 'claude-auto-loge',
  mode: 'auto',
  prompt: 'ship it',
  parent: 'session-parent',
  boardAccess: 'worker',
} satisfies StartSessionRequestInput;

const PARSED_START_BODY = { agent: 'claude-auto-loge', mode: 'auto', prompt: 'ship it', boardAccess: 'none' };

const offline = { throws: new Error('connection refused') };

/** An independent SHA-256 so the recovery digest is checked against the payload, not the client. */
const digestOf = (payload: string): string => new Bun.CryptoHasher('sha256').update(payload).digest('hex');

const bodyStringOf = (transport: QueuedHttpTransport, index = 0): string => String(transport.calls[index]?.init.body);

describe('FyApiClient session start', () => {
  it('should post the parsed start request with the caller request ID and no board capability', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(sessionView));
    const client = await connectClient(transport);

    // Act
    const actual = await client.start(START_INPUT, 'caller-request-1');

    // Assert
    should(actual).deepEqual(sessionView);
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions`);
    should(transport.calls[0]?.init.method).equal('POST');
    should(jsonBodyOf(transport)).deepEqual(PARSED_START_BODY);
    should(headersOf(transport).get('content-type')).equal('application/json');
    should(headersOf(transport).get('x-fy-request-id')).equal('caller-request-1');
    should(headersOf(transport).has('x-fy-board-capability')).be.false();
  });

  it('should generate a request ID and forward a trimmed board capability', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(sessionView));
    const client = await connectClient(transport);

    // Act
    const actual = await client.start(BOARD_START_INPUT, undefined, '  capability-token  ');

    // Assert
    should(actual).deepEqual(sessionView);
    should(jsonBodyOf(transport)).deepEqual({ ...BOARD_START_INPUT });
    should(headersOf(transport).get('x-fy-request-id')).equal('request-1');
    should(headersOf(transport).get('x-fy-board-capability')).equal('capability-token');
  });

  it('should refuse a board-access start that carries no capability', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(BOARD_START_INPUT, undefined, '   '));

    // Assert
    should(actual instanceof Error).be.true();
    should((actual as Error).message).equal('a non-none board-access start requires a board capability');
    should(transport.calls).have.length(0);
  });

  it('should reject a blank caller request ID before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(START_INPUT, '   '));

    // Assert
    should(actual instanceof Error).be.true();
    should(transport.calls).have.length(0);
  });

  it('should replay the identical start request once on a transport failure', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(offline, offline, offline, jsonResponse(sessionView));
    const client = await connectClient(transport);

    // Act
    const actual = await client.start(START_INPUT);

    // Assert
    should(actual).deepEqual(sessionView);
    should(transport.calls).have.length(4);
    should(transport.calls[3]?.url).equal(`${BASE_URL}/v1/sessions`);
    should(bodyStringOf(transport, 3)).equal(bodyStringOf(transport, 0));
    should(headersOf(transport, 3).get('x-fy-request-id')).equal('request-1');
  });

  it('should recover a started session by request ID and payload digest', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      offline,
      offline,
      offline,
      offline,
      offline,
      offline,
      jsonResponse(sessionView),
    );
    const client = await connectClient(transport);

    // Act
    const actual = await client.start(START_INPUT);

    // Assert
    const digest = digestOf(bodyStringOf(transport, 0));
    should(actual).deepEqual(sessionView);
    should(transport.calls).have.length(7);
    should(transport.calls[6]?.url).equal(`${BASE_URL}/v1/sessions/by-request/request-1?payload=${digest}`);
    should(transport.calls[6]?.init.method).be.undefined();
    should(transport.calls[6]?.init.body).be.undefined();
  });

  it('should re-request the board grant for a session recovered with board access', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      offline,
      offline,
      offline,
      offline,
      offline,
      offline,
      jsonResponse(sessionView),
      jsonResponse(taskBoardGrantRequestView),
    );
    const client = await connectClient(transport);

    // Act
    const actual = await client.start(BOARD_START_INPUT, 'caller-request-2', 'capability-token');

    // Assert
    const digest = digestOf(bodyStringOf(transport, 0));
    should(actual).deepEqual(sessionView);
    should(transport.calls).have.length(8);
    should(transport.calls[7]?.url).equal(`${BASE_URL}/v1/task-board/child-grants/request`);
    should(transport.calls[7]?.init.method).equal('POST');
    should(jsonBodyOf(transport, 7)).deepEqual({ targetSessionId: sessionView.config.id, role: 'worker' });
    should(headersOf(transport, 7).get('x-fy-request-id')).equal(`caller-request-2:board-access:${digest}`);
    should(headersOf(transport, 7).get('x-fy-board-capability')).equal('capability-token');
    should(headersOf(transport, 7).get('content-type')).equal('application/json');
  });

  it('should surface a failed board grant rather than returning an ungranted session', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      offline,
      offline,
      offline,
      offline,
      offline,
      offline,
      jsonResponse(sessionView),
      jsonResponse({ error: 'capability expired', code: 'forbidden' }, { status: 403 }),
    );
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(BOARD_START_INPUT, undefined, 'capability-token'));

    // Assert
    should(actual instanceof FyHttpError).be.true();
    should((actual as FyHttpError).status).equal(403);
    should((actual as FyHttpError).message).equal('capability expired');
    should(transport.calls).have.length(8);
  });

  it('should report the original failure when recovery finds no session', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(...Array.from({ length: 9 }, () => offline));
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(START_INPUT));

    // Assert
    should(actual instanceof FyTransportError).be.true();
    should((actual as FyTransportError).path).equal('/v1/sessions');
    should((actual as FyTransportError).message).equal(
      'fyd is unavailable at http://daemon.test/api (connection refused)',
    );
    should(transport.calls).have.length(9);
    should(transport.calls[8]?.url).startWith(`${BASE_URL}/v1/sessions/by-request/request-1?payload=`);
  });

  it('should not replay a start the daemon answered with an HTTP error', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse({ error: 'agent unknown', code: 'invalid_input' }, { status: 400 }),
    );
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(START_INPUT));

    // Assert
    should(actual instanceof FyHttpError).be.true();
    should((actual as FyHttpError).status).equal(400);
    should(transport.calls).have.length(1);
  });

  it('should stop replaying when the replay itself fails with an HTTP error', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(
      offline,
      offline,
      offline,
      jsonResponse({ error: 'duplicate request', code: 'conflict' }, { status: 409 }),
    );
    const client = await connectClient(transport);

    // Act
    const actual = await captureError(() => client.start(START_INPUT));

    // Assert
    should(actual instanceof FyHttpError).be.true();
    should((actual as FyHttpError).status).equal(409);
    should(transport.calls).have.length(4);
  });
});
