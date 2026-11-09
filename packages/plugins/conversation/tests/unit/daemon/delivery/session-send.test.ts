import { describe, expect, it } from 'bun:test';
import { ferretActor } from '@ferretry/core-gate/contract';
import { ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { COMPOSER_OCCUPIED_CODE, SEND_UNCONFIRMED_CODE } from '../../../../daemon/seams/protocol.ts';
import {
  type SentDraftClearer,
  SessionSendError,
  type SessionSendFailure,
  type SessionSendSubsystem,
  sessionSendRoutes,
} from '../../../../daemon/delivery/lib/mounts/session-send.ts';
import { answerOf, refusalOf } from '../../../support/mount-call.ts';

const SEND = '/v1/ferrets/:ferretId/send';
const ID = { ferretId: 'f1' };
const KEY = { 'x-fy-request-id': 'req-1' };

/** A subsystem that records what it was asked and answers `value`, or throws `failure`. */
const build = (options: { value?: unknown; failure?: unknown } = {}) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const answer =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (options.failure !== undefined) throw options.failure;
      return options.value ?? { ok: method };
    };
  const subsystem = Object.fromEntries(
    [
      'send',
      'interrupt',
      'sends',
      'sendStatus',
      'queue',
      'editQueued',
      'cancelQueued',
      'retry',
      'cancel',
      'submit',
      'composer',
      'handoff',
    ].map(method => [method, answer(method)]),
  ) as unknown as SessionSendSubsystem;
  return { subsystem, calls };
};

describe('POST send', () => {
  it('hands the message over with the caller’s own key, and answers the result', async () => {
    const { subsystem, calls } = build({ value: { ferret: 'f1', disposition: 'queued' } });
    const routes = sessionSendRoutes(subsystem);
    const answer = await answerOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      body: { message: 'hi', now: true, replyExpected: true, attachmentIds: ['a1'] },
    });
    expect(answer).toEqual({ status: 200, json: { ferret: 'f1', disposition: 'queued' } });
    expect(calls[0]?.args).toEqual([
      'f1',
      { message: 'hi', sendId: 'req-1', attachmentIds: ['a1'], now: true, replyExpected: true },
    ]);
  });

  it('takes the sender and the label from the ferret’s credential (Gate’s own standing), never from the body', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    const f9 = 'f9' as FerretId;
    const body = { message: 'hi', label: 'fyi' };
    // A ferret's own token: Gate stamps `ferret:f9` and the ferret credential.
    await answerOf(routes, 'POST', SEND, { params: ID, headers: KEY, standing: ferretStanding(f9), body });
    // The admin token plus the session header: Gate stamps `ferret:f9` on an admin credential.
    await answerOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      standing: { actor: ferretActor(f9), credential: { kind: 'authenticated', tokenClass: 'admin' } },
      body,
    });
    // The credential names the ferret first: an actor that says otherwise cannot move the sender.
    await answerOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      standing: { ...ferretStanding(f9), actor: ferretActor('f7' as FerretId) },
      body,
    });
    await answerOf(routes, 'POST', SEND, { params: ID, headers: KEY, standing: ownerStanding(), body });
    await answerOf(routes, 'POST', SEND, { params: ID, headers: KEY, standing: wardenStanding(f9), body });
    expect(calls.map(call => call.args[1])).toEqual([
      { message: 'hi', sendId: 'req-1', label: 'fyi', senderSessionId: 'f9' },
      { message: 'hi', sendId: 'req-1', label: 'fyi', senderSessionId: 'f9' },
      { message: 'hi', sendId: 'req-1', label: 'fyi', senderSessionId: 'f9' },
      { message: 'hi', sendId: 'req-1' },
      { message: 'hi', sendId: 'req-1' },
    ]);
  });

  // Tripwire for the r4 BLOCKER: Gate never stamps `peer:<id>` (it renamed it `ferret:`), so a route that keeps
  // reading that prefix names no sender for any real ferret. An agent call whose actor is `peer:f9` names none here.
  it('reads no `peer:` actor: an agent admin call stamped `peer:f9` names no sender and carries no label', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    await answerOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      standing: { actor: 'peer:f9', credential: { kind: 'authenticated', tokenClass: 'admin' } },
      body: { message: 'hi', label: 'fyi' },
    });
    await answerOf(routes, 'POST', SEND, { params: ID, headers: KEY, actor: 'peer:f9', body: { message: 'hi' } });
    expect(calls.map(call => call.args[1])).toEqual([
      { message: 'hi', sendId: 'req-1' },
      { message: 'hi', sendId: 'req-1' },
    ]);
  });

  it('refuses a path that is not a usable id, a missing key, and a body naming a different key', async () => {
    const routes = sessionSendRoutes(build().subsystem);
    expect(
      (await refusalOf(routes, 'POST', SEND, { params: { ferretId: '' }, headers: KEY, body: { message: 'x' } })).code,
    ).toBe('invalid_session_id');
    expect(
      (await refusalOf(routes, 'POST', SEND, { params: { ferretId: '..%2Fx' }, headers: KEY, body: { message: 'x' } }))
        .code,
    ).toBe('invalid_session_id');
    expect((await refusalOf(routes, 'POST', SEND, { params: ID, body: { message: 'x' } })).code).toBe(
      'missing_request_id',
    );
    const two = await refusalOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      body: { message: 'x', sendId: 'other' },
    });
    expect(two.status).toBe(400);
    expect(two.code).toBe('invalid_request');
  });

  it('clears the owner’s shared draft once the send is accepted, and never at the send’s expense', async () => {
    const { subsystem } = build();
    const cleared: unknown[][] = [];
    const clear: SentDraftClearer = async (...args) => {
      cleared.push(args);
    };
    const position = { generation: 'g1', epoch: 0, base: 2, text: ['x'] };
    const routes = sessionSendRoutes(subsystem, clear);
    await answerOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      actor: 'owner',
      body: { message: 'x', sharedDraft: position },
    });
    expect(cleared).toEqual([['f1', 'owner', 'req-1', position]]);

    // A draft position that is not one is refused.
    const refused = await refusalOf(routes, 'POST', SEND, {
      params: ID,
      headers: KEY,
      body: { message: 'x', sharedDraft: { at: 0 } },
    });
    expect(refused.status).toBe(400);

    // A clearer that refuses leaves the message exactly as sent.
    const failing = sessionSendRoutes(subsystem, async () => {
      throw new Error('moved on');
    });
    const ok = await answerOf(failing, 'POST', SEND, {
      params: ID,
      headers: KEY,
      body: { message: 'x', sharedDraft: position },
    });
    expect(ok.status).toBe(200);
  });

  it('restates each refusal of the service in HTTP words', async () => {
    const expected: Record<SessionSendFailure, [number, string]> = {
      invalid: [400, 'invalid_request'],
      not_found: [404, 'not-found'],
      refused: [409, 'send_refused'],
      pending: [503, 'session_launching'],
      unconfirmed: [409, SEND_UNCONFIRMED_CODE],
      failed: [500, 'session_send_failed'],
    };
    for (const [failure, [status, code]] of Object.entries(expected) as Array<[SessionSendFailure, [number, string]]>) {
      const routes = sessionSendRoutes(build({ failure: new SessionSendError(failure, 'no') }).subsystem);
      const refusal = await refusalOf(routes, 'POST', SEND, { params: ID, headers: KEY, body: { message: 'x' } });
      expect({ failure, status: refusal.status, code: refusal.code }).toEqual({ failure, status, code });
    }
  });

  it('carries the person’s draft when the composer is occupied, and the send id when it is unconfirmed', async () => {
    const occupied = sessionSendRoutes(
      build({ failure: new SessionSendError('refused', 'busy', 'my words') }).subsystem,
    );
    const first = await refusalOf(occupied, 'POST', SEND, { params: ID, headers: KEY, body: { message: 'x' } });
    expect(first.code).toBe(COMPOSER_OCCUPIED_CODE);
    expect(first.extra).toEqual({ draft: 'my words' });
    const unconfirmed = sessionSendRoutes(
      build({ failure: new SessionSendError('unconfirmed', 'typed', undefined, 's9') }).subsystem,
    );
    const second = await refusalOf(unconfirmed, 'POST', SEND, { params: ID, headers: KEY, body: { message: 'x' } });
    expect(second.code).toBe(SEND_UNCONFIRMED_CODE);
    expect(second.extra).toEqual({ sendId: 's9' });
  });

  it('lets a failure that is not the service’s own through unchanged', async () => {
    const routes = sessionSendRoutes(build({ failure: new TypeError('boom') }).subsystem);
    const error = await refusalOf(routes, 'POST', SEND, { params: ID, headers: KEY, body: { message: 'x' } });
    expect(error.message).toBe('boom');
  });
});

describe('POST interrupt', () => {
  const INTERRUPT = '/v1/ferrets/:ferretId/interrupt';

  it('stops the turn and answers the session’s view', async () => {
    const { subsystem, calls } = build({ value: { status: 'idle' } });
    const answer = await answerOf(sessionSendRoutes(subsystem), 'POST', INTERRUPT, { params: ID, body: {} });
    expect(answer).toEqual({ status: 200, json: { status: 'idle' } });
    expect(calls[0]).toEqual({ method: 'interrupt', args: ['f1'] });
  });

  it('declines to abandon a rendered question rather than stop the turn and call it done', async () => {
    const refusal = await refusalOf(sessionSendRoutes(build().subsystem), 'POST', INTERRUPT, {
      params: ID,
      body: { toolUseId: 'tool-1' },
    });
    expect(refusal.status).toBe(501);
    expect(refusal.code).toBe('question_abandon_unsupported');
  });

  it('restates the service’s refusal', async () => {
    const routes = sessionSendRoutes(build({ failure: new SessionSendError('not_found', 'gone') }).subsystem);
    expect((await refusalOf(routes, 'POST', INTERRUPT, { params: ID, body: {} })).status).toBe(404);
  });
});

describe('the send ledger and the queue', () => {
  const SENDS = '/v1/ferrets/:ferretId/sends';
  const QUEUE = '/v1/ferrets/:ferretId/queue';

  const row = (sendId: string, at: string) => ({
    sendId,
    acceptedAt: at,
    fate: 'delivered',
    path: 'direct',
    message: sendId,
  });

  it('pages the ledger newest first, and refuses unknown parameters, a bad limit and a cursor naming no send', async () => {
    const { subsystem } = build({
      value: [row('s1', '2026-11-01T00:00:00.000Z'), row('s2', '2026-11-02T00:00:00.000Z')],
    });
    const routes = sessionSendRoutes(subsystem);
    const page = await answerOf(routes, 'GET', SENDS, { params: ID, query: { limit: '1' } });
    expect(page.status).toBe(200);
    expect((page.json as { sends: Array<{ sendId: string }> }).sends.map(each => each.sendId)).toEqual(['s2']);

    expect((await refusalOf(routes, 'GET', SENDS, { params: ID, query: { page: '2' } })).code).toBe(
      'unknown_parameter',
    );
    for (const limit of ['0', 'x', '1.5', '100000']) {
      expect((await refusalOf(routes, 'GET', SENDS, { params: ID, query: { limit } })).code).toBe('invalid_limit');
    }
    expect((await refusalOf(routes, 'GET', SENDS, { params: ID, query: { before: '' } })).code).toBe('invalid_cursor');
    const unknown = await refusalOf(routes, 'GET', SENDS, { params: ID, query: { before: 'nope' } });
    expect(unknown.code).toBe('invalid_cursor');
    expect(unknown.message).toContain('nope');
  });

  it('pages the queue and refuses a cursor that names none of its messages', async () => {
    const { subsystem } = build({ value: [] });
    const routes = sessionSendRoutes(subsystem);
    const page = await answerOf(routes, 'GET', QUEUE, { params: ID });
    expect(page).toEqual({ status: 200, json: { messages: [], nextCursor: null } });
    expect((await refusalOf(routes, 'GET', QUEUE, { params: ID, query: { before: 'forged' } })).code).toBe(
      'invalid_cursor',
    );
  });

  it('edits and takes back a queued message by its id', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    const target = { ferretId: 'f1', messageId: 'm1' };
    await answerOf(routes, 'PATCH', `${QUEUE}/:messageId`, { params: target, body: { text: ' new words ' } });
    await answerOf(routes, 'DELETE', `${QUEUE}/:messageId`, { params: target });
    expect(calls.map(call => [call.method, ...call.args])).toEqual([
      ['editQueued', 'f1', 'm1', 'new words'],
      ['cancelQueued', 'f1', 'm1'],
    ]);
    const bad = await refusalOf(routes, 'DELETE', `${QUEUE}/:messageId`, { params: { ferretId: 'f1', messageId: '' } });
    expect(bad.code).toBe('invalid_message_id');
  });

  it('reads one send, and refuses a send id that is not usable', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    await answerOf(routes, 'GET', `${SENDS}/:sendId`, { params: { ferretId: 'f1', sendId: 's1' } });
    expect(calls[0]).toEqual({ method: 'sendStatus', args: ['f1', 's1'] });
    expect((await refusalOf(routes, 'GET', `${SENDS}/:sendId`, { params: { ferretId: 'f1', sendId: '' } })).code).toBe(
      'invalid_send_id',
    );
  });

  it('reads a hand-off document by name, and refuses a name that is not one', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    const path = '/v1/ferrets/:ferretId/handoffs/:name';
    await answerOf(routes, 'GET', path, { params: { ferretId: 'f1', name: 'turn-008' } });
    expect(calls[0]).toEqual({ method: 'handoff', args: ['f1', 'turn-008'] });
    expect((await refusalOf(routes, 'GET', path, { params: { ferretId: 'f1', name: 'etc-passwd' } })).code).toBe(
      'invalid_handoff',
    );
  });

  it('retries, cancels and presses Enter on a send, and acts on the composer', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    const target = { ferretId: 'f1', sendId: 's1' };
    await answerOf(routes, 'POST', `${SENDS}/:sendId/retry`, { params: target, body: { force: true } });
    await answerOf(routes, 'POST', `${SENDS}/:sendId/retry`, { params: target, body: {} });
    await answerOf(routes, 'POST', `${SENDS}/:sendId/cancel`, { params: target, body: {} });
    await answerOf(routes, 'POST', `${SENDS}/:sendId/enter`, { params: target, body: {} });
    await answerOf(routes, 'POST', '/v1/ferrets/:ferretId/composer', {
      params: ID,
      body: { action: 'clear', draft: 'my words' },
    });
    expect(calls.map(call => [call.method, ...call.args])).toEqual([
      ['retry', 'f1', 's1', true],
      ['retry', 'f1', 's1', false],
      ['cancel', 'f1', 's1'],
      ['submit', 'f1', 's1'],
      ['composer', 'f1', { action: 'clear', draft: 'my words' }],
    ]);
  });

  it('refuses a press of Enter that carries a body, and does not submit', async () => {
    const { subsystem, calls } = build();
    const routes = sessionSendRoutes(subsystem);
    const refused = await refusalOf(routes, 'POST', `${SENDS}/:sendId/enter`, {
      params: { ferretId: 'f1', sendId: 's1' },
      body: { message: 'x' },
    });
    expect(refused.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
