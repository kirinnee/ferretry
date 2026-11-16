import { describe, expect, test } from 'bun:test';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { sharingIdenticalReads } from '../../../src/session/shared-reads.ts';

/** Moved from today's `shared-reads.test.ts`, onto the transport's request shape. */

interface Sent {
  readonly request: TransportRequest;
  readonly answer: (answer: TransportAnswer) => void;
  readonly fail: (reason: unknown) => void;
}

/** A sender that answers only when the test says so, and records what it was asked. */
const scripted = () => {
  const sent: Sent[] = [];
  const send = (request: TransportRequest): Promise<TransportAnswer> =>
    new Promise<TransportAnswer>((answer, fail) => {
      sent.push({ request, answer, fail });
    });
  return { sent, send };
};

const answerOf = (body: unknown): TransportAnswer => ({ status: 200, headers: {}, body });
const READ: TransportRequest = { method: 'GET', path: '/v1/usage' };

describe('sharingIdenticalReads', () => {
  test('R519 should send one request for identical reads in flight, and hand each caller its own copy', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    const first = subject({ ...READ, headers: { accept: 'application/json' } });
    const second = subject({ ...READ, method: 'get', headers: { Accept: 'application/json' } });
    const original = answerOf({ meter: [1] });
    sender.sent[0]?.answer(original);
    const actual = await Promise.all([first, second]);

    expect(sender.sent).toHaveLength(1);
    expect(actual[0]).toEqual(original);
    expect(actual[1]).toEqual(original);
    // Never the original itself, and never one caller's copy for the other: nobody may mutate what another reads.
    expect(actual[0]).not.toBe(original);
    expect(actual[0]?.body).not.toBe(actual[1]?.body);
  });

  test.each([
    ['another path', { method: 'GET', path: '/v1/projects' }],
    ['another header', { ...READ, headers: { 'if-none-match': '"v1"' } }],
    ['another query', { ...READ, query: { limit: '2' } }],
    ['a HEAD', { ...READ, method: 'HEAD' }],
  ] as const)('R519 should send again for %s', (_name, other) => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    void subject(READ);
    void subject(other);

    expect(sender.sent).toHaveLength(2);
  });

  test('R519 should share reads whose query agrees however its keys were ordered', () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    void subject({ ...READ, query: { a: '1', b: '2' } });
    void subject({ ...READ, query: { b: '2', a: '1' } });

    expect(sender.sent).toHaveLength(1);
  });

  test.each([
    ['a write', { method: 'POST', path: '/v1/usage' }],
    ['a read with a body', { method: 'GET', path: '/v1/usage', body: 'x' }],
  ] as const)('R519 should pass %s straight through, untouched', (_name, input) => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);

    void subject(input);
    void subject(input);

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]?.request).toBe(input);
  });

  test('R519 should send afresh once the shared read has answered: nothing is cached', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const first = subject(READ);
    sender.sent[0]?.answer(answerOf('one'));
    await first;

    void subject(READ);

    expect(sender.sent).toHaveLength(2);
  });

  test('R519 should fail every joined caller with the shared failure, then send afresh', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const first = subject(READ);
    const second = subject(READ);
    const expected = new Error('carrier lost');

    sender.sent[0]?.fail(expected);
    const actual = await Promise.allSettled([first, second]);
    void subject(READ);

    expect(actual.map(result => (result.status === 'rejected' ? result.reason : 'fulfilled'))).toEqual([
      expected,
      expected,
    ]);
    expect(sender.sent).toHaveLength(2);
  });

  test('R519 should answer a caller whose signal fires with its reason, and keep the read for the others', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const impatient = new AbortController();
    const first = subject({ ...READ, signal: impatient.signal });
    const second = subject(READ);
    const reason = new Error('deadline');

    impatient.abort(reason);
    const shared = sender.sent[0]?.request.signal;
    sender.sent[0]?.answer(answerOf('late'));
    const actual = await Promise.allSettled([first, second]);

    expect(actual[0]).toEqual({ status: 'rejected', reason });
    expect(actual[1]?.status).toBe('fulfilled');
    expect(shared?.aborted).toBe(false);
  });

  test('R519 should cancel the shared read once every caller has left, and start afresh after', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const one = new AbortController();
    const two = new AbortController();
    const first = subject({ ...READ, signal: one.signal });
    const second = subject({ ...READ, signal: two.signal });
    const reason = new Error('gone');

    one.abort(reason);
    two.abort(reason);
    const actual = await Promise.allSettled([first, second]);
    void subject(READ);

    expect(actual.every(result => result.status === 'rejected')).toBe(true);
    expect(sender.sent[0]?.request.signal?.aborted).toBe(true);
    expect(sender.sent[0]?.request.signal?.reason).toBe(reason);
    expect(sender.sent).toHaveLength(2);
  });

  test('R519 should refuse a caller that arrives already aborted without leaving others stranded', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const reason = new Error('already');

    const actual = await subject({ ...READ, signal: AbortSignal.abort(reason) }).then(
      () => 'fulfilled',
      (error: unknown) => error,
    );
    void subject(READ);

    expect(actual).toBe(reason);
    expect(sender.sent[0]?.request.signal?.aborted).toBe(true);
    expect(sender.sent).toHaveLength(2);
  });

  test('R519 should ignore an answer or a failure that lands after the caller already left', async () => {
    const sender = scripted();
    const subject = sharingIdenticalReads(sender.send);
    const left = new AbortController();
    const stays = new AbortController();
    const reason = new Error('left');
    const leaving = subject({ ...READ, signal: left.signal });
    const staying = subject({ ...READ, signal: stays.signal });
    const failing = subject({ method: 'GET', path: '/v1/other', signal: left.signal });
    left.abort(reason);

    sender.sent[0]?.answer(answerOf('ok'));
    sender.sent[1]?.fail(new Error('after'));
    const actual = await Promise.allSettled([leaving, staying, failing]);

    expect(actual.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'rejected']);
    expect((actual[2] as PromiseRejectedResult).reason).toBe(reason);
  });
});
