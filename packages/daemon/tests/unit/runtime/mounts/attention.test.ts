import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, type DirectNotificationRequest } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter, type ApiCredentials, type ApiResponse } from '../../../../src/lib/api/index.ts';
import type {
  AttentionLedger,
  AttentionLedgerRepository,
  AttentionMutation,
  AttentionActor,
} from '../../../../src/lib/attention/index.ts';
import type { NotificationResult } from '../../../../src/lib/notifications/index.ts';
import {
  attentionActor,
  attentionRoutes,
  type DirectNotificationSubsystem,
} from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, attentionService, CREDENTIALS, human } from './support.ts';

/** A repository whose reads fail the way a damaged ledger file does. */
class BrokenLedgerRepository implements AttentionLedgerRepository {
  async read(): Promise<AttentionLedger | null> {
    throw new Error('the ledger on disk is not decodable');
  }

  async transact(): Promise<AttentionMutation> {
    return { ok: false, error: { code: 'corrupt', message: 'the ledger on disk is not decodable' } };
  }
}

class FakeNotifications implements DirectNotificationSubsystem {
  readonly calls: Array<{
    readonly sessionId: string;
    readonly request: DirectNotificationRequest;
    readonly actor: AttentionActor;
    readonly attribution: string;
    readonly requestId: string;
  }> = [];
  result: NotificationResult = { ok: true, value: { sessionId: 's1', delivered: 0 } };

  async notifyDirect(
    sessionId: string,
    request: DirectNotificationRequest,
    actor: AttentionActor,
    attribution: string,
    requestId: string,
  ): Promise<NotificationResult> {
    this.calls.push({ sessionId, request, actor, attribution, requestId });
    return this.result;
  }
}

function fixture(
  repository?: AttentionLedgerRepository,
  notifications: DirectNotificationSubsystem = new FakeNotifications(),
  credentials: ApiCredentials = CREDENTIALS,
) {
  const routes = attentionRoutes(attentionService(repository), notifications);
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), credentials, NO_GOVERNED_ROUTES_GUARD);
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const post = (body: unknown, headers: Readonly<Record<string, string>> = human) => ({
  method: 'POST',
  path: '/v1/sessions/s1/attention',
  headers,
  body: JSON.stringify(body),
});

/** A well-formed agent ask. The state machine requires one of the four structured kinds, so a raise
 *  without an `ask` is a refusal rather than an open-ended "please look at this". */
const raise = {
  action: 'add',
  subject: 'which base branch?',
  why: 'the ticket names two',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
} as const;

describe('attentionActor', () => {
  it('should accept only established peer, admin, or paired-device provenance', () => {
    // Arrange / Act / Assert
    should(attentionActor('peer:s1')).deepEqual({ kind: 'agent', sessionId: 's1', name: null });
    should(attentionActor('admin-cli')).deepEqual({ kind: 'human' });
    should(attentionActor('admin-ui')).deepEqual({ kind: 'human' });
    should(attentionActor('device:browser-1')).deepEqual({ kind: 'human' });
    for (const unavailable of ['peer:', 'peer:not/a/session', 'device:', 'warden:s1', 'unknown', undefined]) {
      should(() => attentionActor(unavailable)).throw(/established human or session provenance/u);
    }
  });
});

describe('attention routes', () => {
  it('should answer an empty board rather than a 404 for a session with no ledger yet', async () => {
    // A session that has never blocked has an empty board, which is not the same as a missing one.
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).containDeep({ sessionId: 's1', items: [], resolved: [], count: 0 });
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should raise an item for the agent that asked, and count it as active', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const raised = await dispatch(post(raise, agentIn('s1')));

    // Assert
    should(raised.status).equal(200);
    should(jsonBody(raised)).have.property('count', 1);
    should((jsonBody(raised).items as readonly { subject: string }[])[0]?.subject).equal('which base branch?');
  });

  it('should record the human’s choice when a resolve carries a response', async () => {
    // kteam wrote the resolution without the answer, so an agent waiting on a choice was unblocked
    // with nothing to read.
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;

    // Act
    const answered = await dispatch(
      post({ action: 'resolve', id, response: { kind: 'multiple-choice', choice: 'main' } }),
    );

    // Assert
    should(answered.status).equal(200);
    should(jsonBody(answered)).have.property('count', 0);
    should((jsonBody(answered).resolved as readonly { response?: { choice?: string } }[])[0]?.response?.choice).equal(
      'main',
    );
  });

  it('should refuse an agent raise that declares no structured ask', async () => {
    // An open-ended "look at this" gives the human nothing to answer, so the domain refuses it.
    // Arrange
    const dispatch = fixture();
    const { ask: _ask, ...withoutAsk } = raise;

    // Act
    const response = await dispatch(post(withoutAsk, agentIn('s1')));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
  });

  it('should refuse to resolve an item whose ask would be discarded', async () => {
    // A bare resolve on an item that asked a question would unblock the agent with no answer, so the
    // domain sends the caller to `answer` or `dismiss` instead. The route reports that verbatim.
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;

    // Act
    const resolved = await dispatch(post({ action: 'resolve', id, note: 'handled out of band' }));

    // Assert
    should(resolved.status).equal(400);
    should(jsonBody(resolved)).have.property('code', 'invalid');
    should(String(jsonBody(resolved).error)).match(/answer or dismiss it/u);
  });

  it('should dismiss an item', async () => {
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;

    // Act
    const dismissed = await dispatch(post({ action: 'dismiss', id }));

    // Assert
    should(dismissed.status).equal(200);
    should(jsonBody(dismissed)).have.property('count', 0);
  });

  it('should let an agent dismiss its own item but refuse every other provenance', async () => {
    // Arrange
    const dispatch = fixture();
    const own = await dispatch(post(raise, agentIn('s1')));
    const ownId = (jsonBody(own).items as readonly { id: string }[])[0]?.id;

    // Act
    const ownDismissal = await dispatch(post({ action: 'dismiss', id: ownId }, agentIn('s1')));
    const humanRaised = await dispatch(post({ ...raise, subject: 'human-raised request' }));
    const humanId = (jsonBody(humanRaised).items as readonly { id: string }[])[0]?.id;
    const forgedDismissal = await dispatch(post({ action: 'dismiss', id: humanId }, agentIn('s1')));

    // Assert
    should(ownDismissal.status).equal(200);
    should((jsonBody(ownDismissal).resolved as readonly { disposition: string; resolvedBy: string }[])[0]).containDeep({
      disposition: 'dismissed',
      resolvedBy: 'agent',
    });
    should(forgedDismissal.status).equal(403);
    should(jsonBody(forgedDismissal)).have.property('code', 'forbidden');
  });

  it('should refuse an agent targeting another session before a phantom board can be created', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(post(raise, agentIn('other-session')));

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'forbidden');
  });

  it('should report an action against an unknown item as not found', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(post({ action: 'dismiss', id: 'A99' }));

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response)).have.property('code', 'not-found');
  });

  it('should refuse a malformed session id as a client error', async () => {
    // Arrange
    const dispatch = fixture();

    // Act — a path separator is not addressable, and the domain refuses the id it does get.
    const response = await dispatch({ path: '/v1/sessions/not a session/attention', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
  });

  it('should refuse a path session id that decodes to a traversal step', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/%2e%2e/attention', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_session_id');
  });

  it('should refuse a body the protocol schema rejects, naming the field', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(post({ ...raise, why: '' }));

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid_request');
    should(String(jsonBody(response).error)).match(/why/u);
  });

  it('should report an unreadable ledger as the daemon’s fault, not the caller’s', async () => {
    // Arrange
    const dispatch = fixture(new BrokenLedgerRepository());

    // Act
    const listed = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });
    const acted = await dispatch(post({ action: 'dismiss', id: 'A1' }));

    // Assert
    // A thrown read is a bug in the adapter and surfaces as the dispatcher's internal error…
    should(listed.status).equal(500);
    should(jsonBody(listed)).have.property('code', 'internal_error');
    // …while a stated `corrupt` refusal keeps its own code at the same status.
    should(acted.status).equal(500);
    should(jsonBody(acted)).have.property('code', 'corrupt');
  });

  it('should keep the board out of the warden token’s reach', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({
      path: '/v1/sessions/s1/attention',
      headers: { authorization: `Bearer ${CREDENTIALS.warden}` },
    });

    // Assert
    should(response.status).equal(403);
  });

  it('should answer 401 without a token at all', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/attention' });

    // Assert
    should(response.status).equal(401);
  });

  it('should serve a direct notification with the request id and server-derived human actor', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    notifications.result = { ok: true, value: { sessionId: 's1', delivered: 2 } };
    const dispatch = fixture(undefined, notifications);

    // Act
    const response = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: { ...human, [FY_REQUEST_ID_HEADER]: 'request-1' },
      body: JSON.stringify({ body: 'done' }),
    });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessionId: 's1', delivered: 2 });
    should(response.headers.get('cache-control')).equal('no-store');
    should(notifications.calls).deepEqual([
      {
        sessionId: 's1',
        request: { body: 'done' },
        actor: { kind: 'human' },
        attribution: 'admin-cli',
        requestId: 'request-1',
      },
    ]);
  });

  it('should require a request id before parsing the body', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    const dispatch = fixture(undefined, notifications);

    // Act
    const response = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: human,
      body: '{not json',
    });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'missing_request_id');
    should(notifications.calls).be.empty();
  });

  it('should reject a malformed direct body before calling the domain', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    const dispatch = fixture(undefined, notifications);

    // Act
    const response = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: { ...human, [FY_REQUEST_ID_HEADER]: 'request-1' },
      body: JSON.stringify({ body: '' }),
    });

    // Assert
    should(response.status).equal(400);
    should(notifications.calls).be.empty();
  });

  it('should preserve peer and paired-device attribution from the authorization boundary', async () => {
    // Arrange
    const peerNotifications = new FakeNotifications();
    const deviceNotifications = new FakeNotifications();
    const peer = fixture(undefined, peerNotifications);
    const device = fixture(undefined, deviceNotifications, {
      ...CREDENTIALS,
      devices: { identify: (token: string) => (token === 'device-secret' ? 'browser-1' : undefined) },
    });
    const body = JSON.stringify({ body: 'done' });

    // Act
    const peerResponse = await peer({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: { ...agentIn('s1'), [FY_REQUEST_ID_HEADER]: 'peer-request' },
      body,
    });
    const deviceResponse = await device({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: { authorization: 'Bearer device-secret', [FY_REQUEST_ID_HEADER]: 'device-request' },
      body,
    });

    // Assert
    should(peerResponse.status).equal(200);
    should(deviceResponse.status).equal(200);
    should(peerNotifications.calls[0]).containDeep({
      actor: { kind: 'agent', sessionId: 's1', name: null },
      attribution: 'peer:s1',
    });
    should(deviceNotifications.calls[0]).containDeep({
      actor: { kind: 'human' },
      attribution: 'device:browser-1',
    });
  });

  it('should map every direct domain refusal through the attention taxonomy', async () => {
    // Arrange
    const cases = [
      { code: 'invalid' as const, status: 400 },
      { code: 'forbidden' as const, status: 403 },
      { code: 'not-found' as const, status: 404 },
      { code: 'corrupt' as const, status: 500 },
    ];

    // Act + Assert
    for (const { code, status } of cases) {
      const notifications = new FakeNotifications();
      notifications.result = { ok: false, error: { code, message: `${code} notification` } };
      const dispatch = fixture(undefined, notifications);
      const response = await dispatch({
        method: 'POST',
        path: '/v1/sessions/s1/notify',
        headers: { ...human, [FY_REQUEST_ID_HEADER]: `request-${code}` },
        body: JSON.stringify({ body: 'done' }),
      });
      should(response.status).equal(status);
      should(jsonBody(response)).have.property('code', code);
    }
  });
});
