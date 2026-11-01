import { describe, it } from 'bun:test';
import {
  COMPOSER_OCCUPIED_CODE,
  ComposerDraftResultSchema,
  composerOccupiedDraft,
  FY_REQUEST_ID_HEADER,
  SEND_UNCONFIRMED_CODE,
  type QueuedMessage,
  QueuedMessageSchema,
  SendListResponseSchema,
  type SendRecord,
  SendRecordSchema,
  SendResultSchema,
  SessionHandoffSchema,
  SessionQueueSchema,
  SessionViewSchema,
  unconfirmedSendId,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionSendError, sessionSendRoutes } from '../../../../src/lib/runtime/mounts/session-send.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FakeSessionSend, fromFerret, GRANTED, human } from './support.ts';

/**
 * The surface a running session is spoken to through.
 *
 * Every case goes through the real dispatcher and the real credentials, because two of the facts this
 * mount passes to the domain do not come from the body at all — the idempotency key comes from a
 * header, and the SENDER comes from the credential the request authenticated with. Calling the route
 * function directly would prove neither.
 */

const withRequestId = (headers: Readonly<Record<string, string>>, id = 'req-1') => ({
  ...headers,
  [FY_REQUEST_ID_HEADER]: id,
});

function dispatcher(subsystem = new FakeSessionSend()): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionSendRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

function sendRequest(
  sessionId: string,
  body: string,
  headers: Readonly<Record<string, string>> = withRequestId(human),
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/send`, headers, body });
}

function interruptRequest(
  sessionId: string,
  body = '{}',
  headers: Readonly<Record<string, string>> = human,
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/interrupt`, headers, body });
}

describe('the session send mount', () => {
  it('should hand a message over and answer with the view plus what the transport did', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' })));

    // Assert
    should(response.status).equal(200);
    // Parsed with the protocol's own schema: a body the client would refuse is a send that failed.
    const result = SendResultSchema.parse(JSON.parse(response.body));
    should(result.config.id).equal('s1');
    should(result.disposition).equal('delivered');
    should(sessions.sent).have.length(1);
    should(sessions.sent[0]?.[1]).match({ message: 'ship it', sendId: 'req-1' });
  });

  it('should pass `now` and `replyExpected` through untouched', async () => {
    // Both change what happens to a live agent: one ends the turn it is on, and the other tells the
    // receiver somebody is blocked on the answer. Dropping either at the boundary would be silent.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    await subject.dispatch(
      sendRequest('s1', JSON.stringify({ message: 'stop and read this', now: true, replyExpected: true })),
    );

    // Assert
    should(sessions.sent[0]?.[1]).match({ now: true, replyExpected: true });
  });

  it('should take the sender from the credential, never from the body', async () => {
    // `from` decides how the message is attributed AND whose declared wait it ends, so a caller able
    // to name itself could wake any other session's park.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), withRequestId(agentIn('s2'))));
    await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), withRequestId(human, 'req-2')));

    // Assert
    should(sessions.sent[0]?.[1].senderSessionId).equal('s2');
    // The human's own CLI is not a peer, so nothing is attributed.
    should(sessions.sent[1]?.[1].senderSessionId).be.undefined();
  });

  it('should refuse a send that carries no idempotency key', async () => {
    // Without one, a retried request whose answer was lost becomes a SECOND message the agent reads
    // and acts on twice — the one write in this daemon a duplicate makes expensively wrong.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'ship it' }), human));

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('missing_request_id');
    should(sessions.sent).be.empty();
  });

  it('should refuse a body the protocol does not accept', async () => {
    // Arrange
    const subject = dispatcher();

    // Act
    const empty = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: '' })));
    const unknown = await subject.dispatch(sendRequest('s1', JSON.stringify({ message: 'hi', urgent: true })));

    // Assert
    should(empty.status).equal(400);
    should(unknown.status).equal(400);
  });

  it('should refuse a path parameter that regains a separator', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(sendRequest('a%2Fb', JSON.stringify({ message: 'ship it' })));

    // Assert
    should(response.status).equal(400);
    should((JSON.parse(response.body) as { code: string }).code).equal('invalid_session_id');
    should(sessions.sent).be.empty();
  });

  it('should answer each refusal with the status its next action deserves', async () => {
    // A session that is merely still launching is a RETRY; one that is quarantined is a change of
    // plan. Collapsing them would tell an operator to fix something that is not broken.
    // Arrange
    const subject = dispatcher(
      new FakeSessionSend(['s1'], {
        pending: new SessionSendError('pending', 'still launching'),
        refused: new SessionSendError('refused', 'quarantined'),
        broken: new SessionSendError('failed', 'tmux went away'),
      }),
    );

    // Act
    const pending = await subject.dispatch(sendRequest('pending', JSON.stringify({ message: 'x' })));
    const refused = await subject.dispatch(sendRequest('refused', JSON.stringify({ message: 'x' })));
    const failed = await subject.dispatch(sendRequest('broken', JSON.stringify({ message: 'x' })));
    const missing = await subject.dispatch(sendRequest('nope', JSON.stringify({ message: 'x' })));

    // Assert
    should(pending.status).equal(503);
    should((JSON.parse(pending.body) as { code: string }).code).equal('session_launching');
    should(refused.status).equal(409);
    should(failed.status).equal(500);
    should(missing.status).equal(404);
  });

  it('should refuse an unauthenticated caller before the subsystem is reached', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const anonymous = await subject.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/send', body: JSON.stringify({ message: 'x' }) }),
    );
    const warden = await subject.dispatch(
      sendRequest('s1', JSON.stringify({ message: 'x' }), {
        authorization: `Bearer ${CREDENTIALS.warden}`,
        [FY_REQUEST_ID_HEADER]: 'req-1',
      }),
    );

    // Assert
    should(anonymous.status).equal(401);
    // A warden watches sessions; it does not type into them.
    should(warden.status).equal(403);
    should(sessions.sent).be.empty();
  });
});

describe('the session interrupt mount', () => {
  it('should stop the turn and answer with the view the read surface serves', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(interruptRequest('s1'));

    // Assert
    should(response.status).equal(200);
    const view = SessionViewSchema.parse(JSON.parse(response.body));
    should(view.state.status).equal('interrupted');
    should(sessions.interrupts).deepEqual(['s1']);
  });

  it('should refuse a BOUND abandon rather than approximating it with a turn stop', async () => {
    // A client that names the question it means to abandon is asking for an operation this daemon
    // cannot perform. Answering 200 would report success for something that never happened, and would
    // leave the question on screen with the caller believing it was gone.
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = dispatcher(sessions);

    // Act
    const response = await subject.dispatch(interruptRequest('s1', JSON.stringify({ toolUseId: 'tool-7' })));

    // Assert
    should(response.status).equal(501);
    should((JSON.parse(response.body) as { code: string }).code).equal('question_abandon_unsupported');
    should(sessions.interrupts).be.empty();
  });

  it('should answer a refusal and a missing session with their own statuses', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeSessionSend(['s1'], { refused: new SessionSendError('refused', 'nothing to interrupt') }),
    );

    // Act
    const refused = await subject.dispatch(interruptRequest('refused'));
    const missing = await subject.dispatch(interruptRequest('nope'));

    // Assert
    should(refused.status).equal(409);
    should(missing.status).equal(404);
  });
});

describe('the session send ledger routes', () => {
  const record: SendRecord = {
    v: 1,
    sendId: 'send-1',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    acceptedTurn: 1,
    path: 'direct',
    message: 'ship it',
    attachmentIds: [],
    fate: 'timed_out',
    unaccountedReason: 'not_delivered',
    retryable: true,
  };

  it('should serve the ledger and one send by its id', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    sessions.ledger = [record];
    const subject = dispatcher(sessions);

    // Act
    const list = await subject.dispatch(request({ method: 'GET', path: '/v1/sessions/s1/sends', headers: human }));
    const one = await subject.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/sends/send-1', headers: human }),
    );
    const missing = await subject.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/sends/nope', headers: human }),
    );
    const unusable = await subject.dispatch(
      request({ method: 'GET', path: '/v1/sessions/s1/sends/%2F', headers: human }),
    );

    // Assert
    should(SendListResponseSchema.parse(JSON.parse(list.body)).sends).deepEqual([record]);
    should(SendRecordSchema.parse(JSON.parse(one.body)).fate).equal('timed_out');
    should(missing.status).equal(404);
    should(unusable.status).equal(400);
  });

  it('should serve the ledger a page at a time, and refuse a page it cannot name', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    sessions.ledger = ['send-1', 'send-2', 'send-3'].map((sendId, n) => ({
      ...record,
      sendId,
      fate: 'delivered' as const,
      acceptedAt: `2026-08-01T12:0${String(n)}:00.000Z`,
    }));
    const subject = dispatcher(sessions);
    const get = async (query: Record<string, string>) =>
      await subject.dispatch(
        request({ method: 'GET', path: '/v1/sessions/s1/sends', headers: human, query: Object.entries(query) }),
      );

    // Act
    const first = SendListResponseSchema.parse(JSON.parse((await get({ limit: '2' })).body));
    const older = SendListResponseSchema.parse(
      JSON.parse((await get({ limit: '2', before: first.nextCursor ?? '' })).body),
    );
    const refused = await Promise.all(
      (
        [{ limit: '0' }, { limit: '1001' }, { limit: 'two' }, { since: 'x' }, { before: 'nope' }] as Record<
          string,
          string
        >[]
      ).map(get),
    );

    // Assert
    should(first.sends.map(each => each.sendId)).eql(['send-3', 'send-2']);
    should(first.nextCursor).equal('send-2');
    should(older.sends.map(each => each.sendId)).eql(['send-1']);
    should(older.nextCursor).be.null();
    should(refused.map(each => each.status)).eql([400, 400, 400, 400, 400]);
  });

  it("should serve the session's durable queue, and refuse a session that is not there", async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const message: QueuedMessage = {
      v: 1,
      id: 'q-1',
      sender: 'human',
      text: 'ship it',
      attachmentIds: [],
      enqueuedAt: '2026-08-01T12:00:00.000Z',
      state: 'queued',
      stateAt: '2026-08-01T12:00:00.000Z',
      revision: 1,
      waitReason: 'busy',
    };
    sessions.queued = [message];
    const subject = dispatcher(sessions);

    // Act
    const found = await subject.dispatch(request({ method: 'GET', path: '/v1/sessions/s1/queue', headers: human }));
    const absent = await subject.dispatch(request({ method: 'GET', path: '/v1/sessions/s9/queue', headers: human }));

    // Assert
    should(found.status).equal(200);
    should(SessionQueueSchema.parse(JSON.parse(found.body)).messages).deepEqual([message]);
    should(absent.status).equal(404);
  });

  it('should edit and take back a queued message only while it waits, and refuse the rest', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const waiting: QueuedMessage = {
      v: 1,
      id: 'q-1',
      sender: 'human',
      text: 'ship it',
      attachmentIds: [],
      enqueuedAt: '2026-08-01T12:00:00.000Z',
      state: 'queued',
      stateAt: '2026-08-01T12:00:00.000Z',
      revision: 1,
    };
    sessions.queued = [waiting, { ...waiting, id: 'q-2', state: 'delivered' }];
    const subject = dispatcher(sessions);
    const patch = (path: string, body: unknown) =>
      subject.dispatch(request({ method: 'PATCH', path, headers: human, body: JSON.stringify(body) }));

    // Act
    const edited = await patch('/v1/sessions/s1/queue/q-1', { text: 'ship it now' });
    const cancelled = await subject.dispatch(
      request({ method: 'DELETE', path: '/v1/sessions/s1/queue/q-1', headers: human }),
    );
    const tooLate = await patch('/v1/sessions/s1/queue/q-2', { text: 'too late' });
    const missing = await subject.dispatch(
      request({ method: 'DELETE', path: '/v1/sessions/s1/queue/nope', headers: human }),
    );
    const empty = await patch('/v1/sessions/s1/queue/q-1', { text: '   ' });
    const unusable = await patch('/v1/sessions/s1/queue/%2F', { text: 'x' });

    // Assert
    should(QueuedMessageSchema.parse(JSON.parse(edited.body))).containEql({ text: 'ship it now', revision: 2 });
    should(QueuedMessageSchema.parse(JSON.parse(cancelled.body)).state).equal('cancelled');
    should(tooLate.status).equal(409);
    should(missing.status).equal(404);
    should(empty.status).equal(400);
    should(unusable.status).equal(400);
  });

  it('should retry under the same id, passing a deliberate "send again anyway" through', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    sessions.ledger = [record];
    const subject = dispatcher(sessions);
    const retry = (body: string) =>
      request({ method: 'POST', path: '/v1/sessions/s1/sends/send-1/retry', headers: human, body });

    // Act
    const plain = await subject.dispatch(retry('{}'));
    const forced = await subject.dispatch(retry(JSON.stringify({ force: true })));

    // Assert
    should(plain.status).equal(200);
    should(forced.status).equal(200);
    should(sessions.retries).deepEqual([
      ['s1', 'send-1', false],
      ['s1', 'send-1', true],
    ]);
  });
});

describe('taking a send back, and pressing Enter for one typed and not sent', () => {
  const record: SendRecord = {
    v: 1,
    sendId: 'send-1',
    acceptedAt: '2026-08-01T12:00:00.000Z',
    acceptedTurn: 1,
    path: 'direct',
    message: 'hi',
    attachmentIds: [],
    fate: 'accepted',
    typedNotSent: true,
  };

  it('should hand the session and send to the service and serve the record it settled', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    sessions.ledger = [record];
    const subject = dispatcher(sessions);
    const post = (path: string, body = '{}') => request({ method: 'POST', path, headers: human, body });

    // Act
    const cancelled = await subject.dispatch(post('/v1/sessions/s1/sends/send-1/cancel'));
    const entered = await subject.dispatch(post('/v1/sessions/s1/sends/send-1/enter'));
    const extra = await subject.dispatch(post('/v1/sessions/s1/sends/send-1/cancel', JSON.stringify({ all: true })));
    const extraEnter = await subject.dispatch(post('/v1/sessions/s1/sends/send-1/enter', JSON.stringify({ x: 1 })));
    const missing = await subject.dispatch(post('/v1/sessions/s1/sends/send-9/cancel'));
    const anonymous = await subject.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/sends/send-1/enter', headers: {}, body: '{}' }),
    );

    // Assert
    should(SendRecordSchema.parse(JSON.parse(cancelled.body))).match({ fate: 'cancelled', cancelEffect: 'cleared' });
    should(entered.status).equal(200);
    should([extra.status, extraEnter.status]).deepEqual([400, 400]);
    should(missing.status).equal(404);
    should(anonymous.status).not.equal(200);
    should(sessions.cancels).deepEqual([
      ['s1', 'send-1'],
      ['s1', 'send-9'],
    ]);
    should(sessions.submits).deepEqual([['s1', 'send-1']]);
  });
});

describe('the hand-off read', () => {
  const handoff = {
    name: 'turn-008',
    message: 'look at this',
    attachments: [{ attachmentId: 'att_1', filename: 'shot.png', mime: 'image/png' }],
  };

  it("should serve the person's message behind a pointer, and refuse what it cannot name", async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    sessions.handoffs = { 'turn-008': handoff };
    const subject = dispatcher(sessions);
    const read = (path: string, headers: Readonly<Record<string, string>> = human) =>
      subject.dispatch(request({ method: 'GET', path, headers }));

    // Act
    const found = await read('/v1/sessions/s1/handoffs/turn-008');
    const gone = await read('/v1/sessions/s1/handoffs/turn-009');
    const traversal = await read('/v1/sessions/s1/handoffs/..%2Fconfig');
    const unnamed = await read('/v1/sessions/s1/handoffs/state');
    const elsewhere = await read('/v1/sessions/nope/handoffs/turn-008');
    const anonymous = await read('/v1/sessions/s1/handoffs/turn-008', {});

    // Assert
    should(found.status).equal(200);
    should(SessionHandoffSchema.parse(JSON.parse(found.body))).deepEqual(handoff);
    should(gone.status).equal(404);
    should(traversal.status).equal(400);
    should(unnamed.status).equal(400);
    should(elsewhere.status).equal(404);
    should(anonymous.status).equal(401);
  });
});

describe('the person’s own draft in the composer', () => {
  function governed(subsystem: FakeSessionSend): ApiDispatcher {
    return new ApiDispatcher(new ApiRouter(sessionSendRoutes(subsystem)), CREDENTIALS, GRANTED);
  }

  it('should answer a refused send as composer_occupied, carrying the whole draft', async () => {
    // Arrange — the message quotes only the start; the body is what the app acts on.
    const draft = 'a draft long enough that the refusal message only quotes its start';
    const sessions = new FakeSessionSend(['s1'], {
      s1: new SessionSendError('refused', 'the agent’s composer already holds unsent text', draft),
    });

    // Act
    const response = await dispatcher(sessions).dispatch(sendRequest('s1', JSON.stringify({ message: 'hi' })));

    // Assert
    should(response.status).equal(409);
    const body = JSON.parse(response.body) as unknown;
    should(body).match({ code: COMPOSER_OCCUPIED_CODE, draft });
    should(composerOccupiedDraft(body)).equal(draft);
  });

  it('should answer a send typed but never shown as send_unconfirmed, carrying its id and no tmux words', async () => {
    // Arrange — 409, not 5xx: the caller's next move is a decision about THIS send, never a blind re-post.
    const sessions = new FakeSessionSend(['s1'], {
      s1: new SessionSendError('unconfirmed', 'the message was typed into the agent’s box', undefined, 'send-7'),
    });

    // Act
    const response = await dispatcher(sessions).dispatch(sendRequest('s1', JSON.stringify({ message: 'hi' })));

    // Assert
    should(response.status).equal(409);
    const body = JSON.parse(response.body) as unknown;
    should(body).match({ code: SEND_UNCONFIRMED_CODE, sendId: 'send-7' });
    should(unconfirmedSendId(body)).equal('send-7');
    should(response.body).not.match(/tmux/u);
  });

  it('should keep every other refusal as it was, with no draft in the body', async () => {
    // Arrange
    const sessions = new FakeSessionSend(['s1'], { s1: new SessionSendError('refused', 'quarantined') });

    // Act
    const response = await dispatcher(sessions).dispatch(sendRequest('s1', JSON.stringify({ message: 'hi' })));

    // Assert
    should(response.status).equal(409);
    should(composerOccupiedDraft(JSON.parse(response.body))).be.undefined();
    should(JSON.parse(response.body)).match({ code: 'send_refused' });
  });

  it('should hand a submit or clear to the service and serve what it did', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const subject = governed(sessions);
    const post = (body: unknown) =>
      subject.dispatch(
        request({
          method: 'POST',
          path: '/v1/sessions/s1/composer',
          headers: human,
          loopback: true,
          body: JSON.stringify(body),
        }),
      );

    // Act
    const submitted = await post({ action: 'submit', draft: 'fix the login bug' });
    const cleared = await post({ action: 'clear', draft: 'fix the login bug' });
    const unknown = await post({ action: 'wipe', draft: 'x' });
    const empty = await post({ action: 'clear', draft: '' });
    const extra = await post({ action: 'clear', draft: 'x', all: true });

    // Assert
    should(ComposerDraftResultSchema.parse(JSON.parse(submitted.body))).deepEqual({
      action: 'submit',
      outcome: 'submitted',
    });
    should(ComposerDraftResultSchema.parse(JSON.parse(cleared.body))).match({ outcome: 'cleared' });
    should([unknown.status, empty.status, extra.status]).deepEqual([400, 400, 400]);
    should(sessions.drafts).deepEqual([
      ['s1', { action: 'submit', draft: 'fix the login bug' }],
      ['s1', { action: 'clear', draft: 'fix the login bug' }],
    ]);
  });

  it('should refuse a ferret the owner’s draft, on its own credential or the admin token, before reading it', async () => {
    // Arrange — typing the owner's draft into a pane is the owner's act, like the console's input.
    const sessions = new FakeSessionSend();
    const asked = (headers: Readonly<Record<string, string>>) => ({
      ...request({ method: 'POST', path: '/v1/sessions/s1/composer', headers, loopback: true }),
      text: async (): Promise<string> => {
        throw new Error('the draft was read');
      },
    });

    // Act
    const answers = [
      await governed(sessions).dispatch(asked(agentIn('s2'))),
      await governed(sessions).dispatch(fromFerret(asked(human))),
    ];

    // Assert
    should(answers.map(answer => [answer.status, JSON.parse(answer.body).code])).deepEqual([
      [403, 'owner_only'],
      [403, 'owner_only'],
    ]);
    should(sessions.drafts).be.empty();
  });

  it('should be a governed terminal key, refused to a caller with no credential', async () => {
    // Arrange
    const sessions = new FakeSessionSend();
    const route = sessionSendRoutes(sessions).find(entry => entry.path === '/v1/sessions/:sessionId/composer');

    // Act
    const anonymous = await governed(sessions).dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/composer', headers: {}, body: '{}' }),
    );

    // Assert
    should(route).match({ minimum: 'operator', caller: 'person', capability: { capability: 'terminal', axis: 'use' } });
    should(anonymous.status).equal(401);
    should(sessions.drafts).be.empty();
  });
});

describe('a send that carries what it takes out of the shared draft (&F331 H1)', () => {
  const sharedDraft = { generation: 'g', epoch: 0, base: 3, text: [-5, 6] };
  const body = (extra: object = {}) => JSON.stringify({ message: 'hello', sharedDraft, ...extra });

  it('hands it to the clearer only once the send is accepted, with the session, the caller and the request id', async () => {
    const cleared: unknown[] = [];
    const subsystem = new FakeSessionSend(['s1']);
    const routes = sessionSendRoutes(subsystem, async (...args) => {
      cleared.push(args);
    });
    const dispatch = new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    const accepted = await dispatch.dispatch(sendRequest('s1', body()));
    const refused = await dispatch.dispatch(sendRequest('s2', body(), withRequestId(human, 'req-2')));

    should(accepted.status).equal(200);
    should(refused.status).not.equal(200);
    should(cleared).deepEqual([['s1', 'admin-cli', 'req-1', sharedDraft]]);
  });

  it('never fails the send when the draft cannot be cleared, and ignores the field with no clearer at all', async () => {
    const failing = new ApiDispatcher(
      new ApiRouter(
        sessionSendRoutes(new FakeSessionSend(), async () => {
          throw new Error('draft moved on');
        }),
      ),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );
    should((await failing.dispatch(sendRequest('s1', body()))).status).equal(200);
    should((await dispatcher().dispatch(sendRequest('s1', body()))).status).equal(200);
  });
});
