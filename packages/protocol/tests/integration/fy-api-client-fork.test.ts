import { describe, it } from 'bun:test';
import should from 'should';
import { FY_REQUEST_ID_HEADER } from '../../src/lib/client.ts';
import { forkOutcome, forkPoint, forkRequest, forkSelectionBinding } from '../fork-fixtures.ts';
import { BASE_URL, connectClient, headersOf, jsonBodyOf } from './client-harness.ts';
import { captureError, jsonResponse, QueuedHttpTransport } from './fakes.ts';

/**
 * `IFyApiClient.fork` — the one call that turns a message a user clicked into a new session.
 *
 * What can break in a delegation is the verb, the path, the request schema applied to the body, the
 * response schema applied to the payload, and the logical request id. The last one is not cosmetic
 * here: `request()` retries a POST up to three times on transport failure, so an id that changed
 * between attempts would present the daemon with three different forks of the same conversation and
 * leave two orphaned sessions behind.
 */

const SESSION_ID = 'session-1';
const FORK_PATH = `${BASE_URL}/v1/sessions/session-1/fork`;

describe('the fy api client, forking a conversation', () => {
  it('should POST the parsed request to the source session and answer with the parsed outcome', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(forkOutcome));
    const client = await connectClient(transport);

    // Act
    const actual = await client.fork(SESSION_ID, forkRequest);

    // Assert
    should(transport.calls[0]?.url).equal(FORK_PATH);
    should(transport.calls[0]?.init.method).equal('POST');
    should(jsonBodyOf(transport)).deepEqual(forkRequest);
    should(headersOf(transport).get('content-type')).equal('application/json');
    // The whole public outcome, parsed: the fresh session summary AND the safe plan projection that
    // owns every omission.
    should(actual).deepEqual(forkOutcome);
    should(actual.plan.notCarried).have.length(1);
  });

  it('should send only the fields the caller stated, and encode the source id in the path', async () => {
    // A model or an effort the caller did not choose must not arrive as a null or an empty string:
    // the target resolver reads "unstated" from the field's absence.
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(forkOutcome));
    const client = await connectClient(transport);

    // Act
    await client.fork('sessions/../secrets', {
      through: forkPoint,
      selectionBinding: forkSelectionBinding,
      agent: 'claude-auto',
    });

    // Assert
    should(transport.calls[0]?.url).equal(`${BASE_URL}/v1/sessions/sessions%2F..%2Fsecrets/fork`);
    should(jsonBodyOf(transport)).deepEqual({
      through: forkPoint,
      selectionBinding: forkSelectionBinding,
      agent: 'claude-auto',
    });
  });

  it('should echo the selection evidence byte-for-byte rather than normalizing it', async () => {
    // The binding is daemon-issued and daemon-verified. A client that trimmed it, re-encoded it,
    // hashed it, or rebuilt it from the point would present a token nobody issued — and the honest
    // `selection_stale` refusal that followed would read as evidence the transcript had changed.
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(forkOutcome));
    const client = await connectClient(transport);

    // Act
    await client.fork(SESSION_ID, forkRequest);

    // Assert — the parsed body keeps the exact characters, and the RAW body carries them JSON-
    // encoded rather than URL-escaped or stripped.
    const sent = jsonBodyOf(transport) as { selectionBinding: string };
    should(sent.selectionBinding).equal(forkSelectionBinding);
    should(String(transport.calls[0]?.init.body)).containEql(JSON.stringify(forkSelectionBinding).slice(1, -1));
    // No derivation surrogate travelled with it: the point is the only other address on the wire.
    should(Object.keys(sent).sort()).deepEqual(['agent', 'effort', 'model', 'selectionBinding', 'through']);
  });

  it('should refuse a fork that names a message without the evidence issued for it', async () => {
    // Arrange
    const { selectionBinding: _binding, ...unbound } = forkRequest;
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const rejected = await captureError(
      async () => await client.fork(SESSION_ID, unbound as unknown as typeof forkRequest),
    );

    // Assert — refused in the client, before any transport I/O.
    should(rejected).be.an.Error();
    should(transport.calls).be.empty();
  });

  it('should mint exactly one logical request id per call and hold it across every retry', async () => {
    // Arrange — two transport failures, so all three attempts of ONE fork are observable.
    const transport = new QueuedHttpTransport(
      { throws: new Error('connection reset') },
      { throws: new Error('connection reset') },
      jsonResponse(forkOutcome),
    );
    let minted = 0;
    const client = await connectClient(transport, {
      requestId: () => {
        minted += 1;
        return `fork-request-${minted}`;
      },
    });

    // Act
    await client.fork(SESSION_ID, forkRequest);

    // Assert — one id minted, and the same id on all three attempts. A daemon that saw three ids
    // would perform three forks of the same conversation.
    should(minted).equal(1);
    should(transport.calls).have.length(3);
    should(transport.calls.map((_, index) => headersOf(transport, index).get(FY_REQUEST_ID_HEADER))).deepEqual([
      'fork-request-1',
      'fork-request-1',
      'fork-request-1',
    ]);
  });

  it('should carry the caller-supplied request id so a repeat is a replay rather than a second fork', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(forkOutcome), jsonResponse(forkOutcome));
    let minted = 0;
    const client = await connectClient(transport, {
      requestId: () => {
        minted += 1;
        return `minted-${minted}`;
      },
    });

    // Act — the same caller-supplied id twice, exactly as a client resuming an interrupted fork does.
    await client.fork(SESSION_ID, forkRequest, 'operator-chosen-1');
    await client.fork(SESSION_ID, forkRequest, 'operator-chosen-1');

    // Assert
    should(minted).equal(0);
    should([0, 1].map(index => headersOf(transport, index).get(FY_REQUEST_ID_HEADER))).deepEqual([
      'operator-chosen-1',
      'operator-chosen-1',
    ]);
  });

  it('should refuse a request the wire does not carry before anything is sent', async () => {
    // The request schema is applied in the CLIENT, so a caller that invented a field learns it is not
    // a fork rather than having it silently dropped on the way to a daemon that would refuse it.
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);

    // Act
    const rejected = await captureError(
      async () =>
        await client.fork(SESSION_ID, { ...forkRequest, boardAccess: 'reader' } as unknown as typeof forkRequest),
    );

    // Assert
    should(rejected).be.an.Error();
    should(transport.calls).be.empty();
  });

  it('should refuse an outcome the wire does not describe rather than returning it', async () => {
    // A fork that happened and cannot be reported is still a defect the caller must see: a body
    // missing its plan would leave every omission unrenderable.
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse({ session: forkOutcome.session }));
    const client = await connectClient(transport);

    // Act
    const rejected = await captureError(async () => await client.fork(SESSION_ID, forkRequest));

    // Assert
    should(rejected).be.an.Error();
  });

  it('should refuse daemon-local plan or session fields rather than returning a stripped leak', async () => {
    // Strict parsing is important in this direction: silently stripping a leaked cwd would make the
    // client look safe while the server was still publishing it to every relay between them.
    // Arrange
    const transport = new QueuedHttpTransport(
      jsonResponse({
        ...forkOutcome,
        session: { ...forkOutcome.session, cwd: '/daemon/work', correlationToken: 'private-proof' },
        plan: {
          ...forkOutcome.plan,
          target: { ...forkOutcome.plan.target, accountId: 'private-account' },
          facets: { workspace: { cwd: '/daemon/work' } },
        },
      }),
    );
    const client = await connectClient(transport);

    // Act
    const rejected = await captureError(async () => await client.fork(SESSION_ID, forkRequest));

    // Assert
    should(rejected).be.an.Error();
  });

  it('should refuse a blank caller-supplied request id instead of forking without one', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(forkOutcome));
    const client = await connectClient(transport);

    // Act
    const rejected = await captureError(async () => await client.fork(SESSION_ID, forkRequest, '   '));

    // Assert
    should(rejected).be.an.Error();
    should(transport.calls).be.empty();
  });
});
