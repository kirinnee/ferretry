import { describe, it } from 'bun:test';
import should from 'should';
import { sharingIdenticalReads } from '../../src/lib/shared-reads.ts';

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly answer: (response: Response) => void;
  readonly fail: (reason: unknown) => void;
}

/** A sender that answers only when the test says so, and records what it was asked. */
const scripted = () => {
  const sent: Sent[] = [];
  const send = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((answer, fail) => {
      sent.push({ url: input instanceof Request ? input.url : input.toString(), init, answer, fail });
    });
  return { sent, send };
};

const URL_A = 'https://daemon.test/v1/usage';

describe('sharingIdenticalReads', () => {
  it('should send one request for identical reads in flight, and hand each caller its own copy', async () => {
    // Arrange — a response that says which copy it is, so the test reads no stream (a DOM suite's
    // `Response` may not be the browser's).
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    let copies = 0;
    const original = { clone: () => ({ copy: ++copies }) } as unknown as Response;

    // Act
    const first = subject(URL_A, { headers: { accept: 'application/json' } });
    const second = subject(URL_A, { method: 'get', headers: { Accept: 'application/json' } });
    sender.sent[0]?.answer(original);
    const actual = await Promise.all([first, second]);

    // Assert — never the original itself, which no caller may consume for the others.
    should(sender.sent).have.length(1);
    should(actual).deepEqual([{ copy: 1 }, { copy: 2 }]);
  });

  it.each([
    ['another url', 'https://daemon.test/v1/projects', {}],
    ['another header', URL_A, { headers: { 'if-none-match': '"v1"' } }],
    ['a HEAD', URL_A, { method: 'HEAD' }],
  ])('should send again for %s', (_name, url, init) => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    // Act
    void subject(URL_A, {});
    void subject(url, init as RequestInit);

    // Assert
    should(sender.sent).have.length(2);
  });

  it.each([
    ['a write', { method: 'POST' }],
    ['a read with a body', { method: 'GET', body: 'x' }],
  ])('should pass %s straight through, untouched', (_name, init) => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const input = init as RequestInit;

    // Act
    void subject(URL_A, input);
    void subject(URL_A, input);

    // Assert
    should(sender.sent).have.length(2);
    should(sender.sent[0]?.init).equal(input);
  });

  it('should send afresh once the shared read has answered: nothing is cached', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const first = subject(URL_A, {});
    sender.sent[0]?.answer(new Response('one'));
    await first;

    // Act
    void subject(URL_A, {});

    // Assert
    should(sender.sent).have.length(2);
  });

  it('should fail every joined caller with the shared failure, then send afresh', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const first = subject(URL_A, {});
    const second = subject(URL_A, {});
    const expected = new Error('carrier lost');

    // Act
    sender.sent[0]?.fail(expected);
    const actual = await Promise.allSettled([first, second]);
    void subject(URL_A, {});

    // Assert
    should(actual.map(result => (result.status === 'rejected' ? result.reason : 'fulfilled'))).deepEqual([
      expected,
      expected,
    ]);
    should(sender.sent).have.length(2);
  });

  it('should answer a caller whose signal fires with its reason, and keep the read for the others', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const impatient = new AbortController();
    const first = subject(URL_A, { signal: impatient.signal });
    const second = subject(URL_A, {});
    const reason = new Error('deadline');

    // Act
    impatient.abort(reason);
    const shared = sender.sent[0]?.init.signal;
    sender.sent[0]?.answer(new Response('late'));
    const actual = await Promise.allSettled([first, second]);

    // Assert
    should(actual[0]).deepEqual({ status: 'rejected', reason });
    should(actual[1]?.status).equal('fulfilled');
    should(shared?.aborted).equal(false);
  });

  it('should cancel the shared read once every caller has left, and start afresh after', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const one = new AbortController();
    const two = new AbortController();
    const first = subject(URL_A, { signal: one.signal });
    const second = subject(URL_A, { signal: two.signal });
    const reason = new Error('gone');

    // Act
    one.abort(reason);
    two.abort(reason);
    const actual = await Promise.allSettled([first, second]);
    void subject(URL_A, {});

    // Assert
    should(actual.every(result => result.status === 'rejected')).be.true();
    should(sender.sent[0]?.init.signal?.aborted).be.true();
    should(sender.sent[0]?.init.signal?.reason).equal(reason);
    should(sender.sent).have.length(2);
  });

  it('should refuse a caller that arrives already aborted without leaving others stranded', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const reason = new Error('already');
    const gone = AbortSignal.abort(reason);

    // Act
    const actual = await subject(URL_A, { signal: gone }).then(
      () => 'fulfilled',
      (error: unknown) => error,
    );
    void subject(URL_A, {});

    // Assert
    should(actual).equal(reason);
    should(sender.sent[0]?.init.signal?.aborted).be.true();
    should(sender.sent).have.length(2);
  });

  it('should ignore an answer or a failure that lands after the caller already left', async () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const left = new AbortController();
    const stays = new AbortController();
    const reason = new Error('left');
    const leaving = subject(URL_A, { signal: left.signal });
    const staying = subject(URL_A, { signal: stays.signal });
    const failing = subject('https://daemon.test/v1/other', { signal: left.signal });
    left.abort(reason);

    // Act
    sender.sent[0]?.answer(new Response('ok'));
    sender.sent[1]?.fail(new Error('after'));
    const actual = await Promise.allSettled([leaving, staying, failing]);

    // Assert
    should(actual.map(result => result.status)).deepEqual(['rejected', 'fulfilled', 'rejected']);
    should((actual[2] as PromiseRejectedResult).reason).equal(reason);
  });
});

describe('sharingIdenticalReads · scope', () => {
  it('should keep reads apart whose scope differs, and share reads whose scope agrees', () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send, init => String((init as { machine?: string }).machine));
    const studio = { machine: 'studio' } as RequestInit;
    const laptop = { machine: 'laptop' } as RequestInit;

    // Act
    void subject(URL_A, studio);
    void subject(URL_A, laptop);
    void subject(URL_A, { ...studio });

    // Assert
    should(sender.sent).have.length(2);
  });
});

describe('sharingIdenticalReads · inputs', () => {
  it('should share a URL object and a string naming the same read, with no init at all', () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    // Act
    void subject(new URL(URL_A));
    void subject(URL_A);

    // Assert
    should(sender.sent).have.length(1);
    should(sender.sent[0]?.url).equal(URL_A);
  });

  it('should pass a Request straight through, every time', () => {
    // Arrange
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const input = new Request(URL_A);

    // Act
    void subject(input);
    void subject(input);

    // Assert
    should(sender.sent).have.length(2);
  });
});
