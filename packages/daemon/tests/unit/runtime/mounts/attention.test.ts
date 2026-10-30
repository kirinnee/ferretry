import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { type ApiCredentials, ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import type {
  AttentionLedger,
  AttentionLedgerRepository,
  AttentionMutation,
} from '../../../../src/lib/attention/index.ts';
import {
  attentionActor,
  attentionRoutes,
  type DirectNotificationSubsystem,
} from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, attentionService, CREDENTIALS, human, NO_HELD_REPLIES } from './support.ts';

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
  readonly asked: Array<{ readonly sessionId: string; readonly attentionId: string }> = [];
  delivered = 0;
  enrolled: number | Error = 2;

  async enrolledDevices(): Promise<number> {
    if (this.enrolled instanceof Error) throw this.enrolled;
    return this.enrolled;
  }

  async attentionDelivered(sessionId: string, attentionId: string): Promise<number> {
    this.asked.push({ sessionId, attentionId });
    return this.delivered;
  }
}

function fixture(
  repository?: AttentionLedgerRepository,
  notifications: DirectNotificationSubsystem = new FakeNotifications(),
  credentials: ApiCredentials = CREDENTIALS,
) {
  const routes = attentionRoutes(attentionService(repository), notifications, NO_HELD_REPLIES);
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
  title: 'Release unblock',
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

  it('should record a raise carrying the CLI’s session header as that ferret’s, and one without it as the human’s', async () => {
    // Arrange — the headers are the ones `fy attention add` sends from inside a ferret's pane and from
    // the person's own shell. The live defect sent the second from both, so every ferret's raise was
    // stored as the human's, and the owner's answer was never delivered back to the ferret.
    const dispatch = fixture();

    // Act
    const fromFerret = await dispatch(post(raise, agentIn('s1')));
    const fromShell = await dispatch(post({ ...raise, subject: 'from the shell' }));

    // Assert
    const items = jsonBody(fromShell).items as readonly { subject: string; raisedBy: string }[];
    should(jsonBody(fromFerret).items).containDeep([{ raisedBy: 'agent', raisedBySession: 's1' }]);
    should(items.find(item => item.subject === 'from the shell')).containDeep({ raisedBy: 'human' });
  });

  it('should say how many devices a new item reached, only on the raise that created it', async () => {
    // Arrange
    const none = new FakeNotifications();
    none.enrolled = 0;
    const dispatch = fixture(undefined, none);

    // Act
    const raised = await dispatch(post(raise, agentIn('s1')));
    const again = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;
    const answered = await dispatch(post({ action: 'dismiss', id }, agentIn('s1')));

    // Assert — zero is the case worth saying: the ask is on the board and nobody was told.
    should(jsonBody(raised)).have.property('enrolled', 0);
    should(jsonBody(again)).not.have.property('enrolled');
    should(jsonBody(answered)).not.have.property('enrolled');
  });

  it('should raise the item even when the enrolled devices cannot be counted, and claim no count', async () => {
    // Arrange
    const broken = new FakeNotifications();
    broken.enrolled = new Error('push store unreadable');
    const dispatch = fixture(undefined, broken);

    // Act
    const raised = await dispatch(post(raise, agentIn('s1')));

    // Assert
    should(raised.status).equal(200);
    should(jsonBody(raised)).have.property('count', 1);
    should(jsonBody(raised)).not.have.property('enrolled');
  });

  it('should answer a clean raise with no warnings, and a hard-to-read one with advice that edit then clears', async () => {
    // Arrange
    const dispatch = fixture();
    const hard = { ...raise, subject: 'Unblock ABC-123 via https://example.com', context: ['the OCI login'] };

    // Act
    const clean = await dispatch(post({ ...raise, premise: ['two base branches exist'] }, agentIn('s1')));
    const warned = await dispatch(post(hard, agentIn('s1')));
    const id = (jsonBody(warned).items as readonly { id: string }[])[1]?.id;
    const fixed = await dispatch(
      post({ action: 'edit', id, subject: 'Unblock the release', context: ['the cloud login'] }, agentIn('s1')),
    );

    // Assert
    should(jsonBody(clean)).not.have.property('warnings');
    should((jsonBody(warned).warnings as readonly string[]).join('\n')).match(/ABC-123[\s\S]*example\.com[\s\S]*OCI/u);
    should(fixed.status).equal(200);
    should(jsonBody(fixed)).not.have.property('warnings');
    should((jsonBody(fixed).items as readonly { subject: string; context: string }[])[1]).containDeep({
      subject: 'Unblock the release',
      context: '- the cloud login',
    });
  });

  it('should warn, never refuse, a decision raised with no premise and no context', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(post(raise, agentIn('s1')));

    // Assert
    should(response.status).equal(200);
    should((jsonBody(response).warnings as readonly string[]).join('\n')).match(/cannot tell what is going on/u);
    should(jsonBody(response).items as readonly unknown[]).have.length(1);
  });

  it('should report an edit of an unknown item as not found', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));

    // Act
    const unknown = await dispatch(post({ action: 'edit', id: 'A9', subject: 'x' }, agentIn('s1')));

    // Assert
    should(unknown.status).equal(404);
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

  it('should resolve an item with a structured ask in words, keeping no invented answer', async () => {
    // The owner may reply in words instead of picking; the note carries them to the ferret (docs/attention.md).
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;

    // Act
    const resolved = await dispatch(post({ action: 'resolve', id, note: 'handled out of band' }));

    // Assert
    should(resolved.status).equal(200);
    should(jsonBody(resolved)).have.property('count', 0);
    should((jsonBody(resolved).resolved as readonly Record<string, unknown>[])[0]).containDeep({
      resolutionNote: 'handled out of band',
      disposition: 'done',
    });
    should((jsonBody(resolved).resolved as readonly Record<string, unknown>[])[0]).not.have.property('response');
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

  it('should turn a notify into an info item the calling ferret raised, and answer how many devices it reached', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    notifications.delivered = 2;
    const dispatch = fixture(undefined, notifications);

    // Act
    const response = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: agentIn('s1'),
      body: JSON.stringify({ body: 'The release is ready for review.', title: 'Release ready' }),
    });
    const board = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({ sessionId: 's1', delivered: 2 });
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(board).items).containDeep([
      {
        kind: 'info',
        title: 'Release ready',
        subject: 'The release is ready for review.',
        source: 'agent-raised',
        raisedBy: 'agent',
        raisedBySession: 's1',
      },
    ]);
    should(notifications.asked).deepEqual([{ sessionId: 's1', attentionId: 'A1' }]);
  });

  it('should title a notify from the start of its text, and keep a long text whole in the context', async () => {
    // Arrange
    const dispatch = fixture();
    const long = `The nightly backup finished and every table was verified against the copy. ${'More detail. '.repeat(30)}`;

    // Act
    await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: human,
      body: JSON.stringify({ body: long }),
    });
    const board = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });

    // Assert
    const [item] = jsonBody(board).items as readonly { title: string; subject: string; context: string }[];
    should(item?.title.length).be.lessThanOrEqual(40);
    should(item?.title.endsWith('…')).be.true();
    should(item?.subject.length).be.lessThanOrEqual(240);
    should(item?.context).equal(long.trim());
  });

  it('should raise a notify as a notice, for a ferret and for a human operator alike', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const byFerret = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: agentIn('s1'),
      body: JSON.stringify({ body: 'The backup finished.' }),
    });
    const byOperator = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: human,
      body: JSON.stringify({ body: 'A different note.' }),
    });
    const board = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });

    // Assert
    should(byFerret.status).equal(200);
    should(byOperator.status).equal(200);
    const items = jsonBody(board).items as readonly { notice?: boolean; kind: string; ask?: unknown }[];
    should(items.length).equal(2);
    for (const item of items) should(item).containDeep({ notice: true, kind: 'info' });
    for (const item of items) should(item.ask).be.undefined();
  });

  it('should not raise the same notify twice while its item is still open, and report no devices', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    notifications.delivered = 1;
    const dispatch = fixture(undefined, notifications);
    const send = async () =>
      await dispatch({
        method: 'POST',
        path: '/v1/sessions/s1/notify',
        headers: agentIn('s1'),
        body: JSON.stringify({ body: 'done' }),
      });

    // Act
    const first = await send();
    const retry = await send();
    const board = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });

    // Assert
    should(jsonBody(first)).have.property('delivered', 1);
    should(jsonBody(retry)).have.property('delivered', 0);
    should(jsonBody(board)).have.property('count', 1);
  });

  it('should refuse a notify that says it is progress or finishing, raising nothing', async () => {
    // Arrange
    const notifications = new FakeNotifications();
    const dispatch = fixture(undefined, notifications);

    // Act + Assert
    for (const kind of ['completed', 'failed']) {
      const response = await dispatch({
        method: 'POST',
        path: '/v1/sessions/s1/notify',
        headers: agentIn('s1'),
        body: JSON.stringify({ body: 'all done', kind }),
      });
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid');
      should(String(jsonBody(response).error)).match(/progress and finishing never notify the owner/u);
    }
    const board = await dispatch({ path: '/v1/sessions/s1/attention', headers: human });
    should(jsonBody(board)).have.property('count', 0);
    should(notifications.asked).be.empty();
  });

  it('should reject a malformed notify body before raising anything', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      headers: human,
      body: JSON.stringify({ body: '' }),
    });

    // Assert
    should(response.status).equal(400);
  });

  it('should keep a ferret to its own session and say so for an unknown one', async () => {
    // Arrange
    const dispatch = fixture();
    const body = JSON.stringify({ body: 'done' });

    // Act
    const other = await dispatch({ method: 'POST', path: '/v1/sessions/s1/notify', headers: agentIn('s2'), body });
    const unknown = await dispatch({ method: 'POST', path: '/v1/sessions/s9/notify', headers: human, body });
    const device = await dispatch({
      method: 'POST',
      path: '/v1/sessions/s1/notify',
      device: { deviceId: 'browser-1', appSession: 'app-one' },
      body,
    });

    // Assert
    should(other.status).equal(403);
    should(unknown.status).equal(404);
    should(device.status).equal(200);
  });
});

describe('attention routes and held answers', () => {
  it('should serve the board without `replies` when the outbox cannot be read', async () => {
    // Arrange
    const routes = attentionRoutes(attentionService(), new FakeNotifications(), {
      pending: async () => {
        throw new Error('outbox unreadable');
      },
      delivery: async () => {
        throw new Error('outbox unreadable');
      },
      sendNow: async () => undefined,
    });
    const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attention', headers: human }));

    // Assert — the board is the answer; a held outbox is decoration.
    should(response.status).equal(200);
    should(jsonBody(response)).not.have.property('replies');
    should(jsonBody(response)).not.have.property('delivery');
  });

  it('should serve the answers on their way as `delivery`, beside the held ones', async () => {
    // Arrange
    const routes = attentionRoutes(attentionService(), new FakeNotifications(), {
      pending: async () => undefined,
      delivery: async () => ({ sending: ['A2'], heldForComposer: true }),
      sendNow: async () => undefined,
    });
    const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attention', headers: human }));

    // Assert — "Sending…" is told from the board itself.
    should(response.status).equal(200);
    should(jsonBody(response))
      .have.property('delivery')
      .deepEqual({ sending: ['A2'], heldForComposer: true });
    should(jsonBody(response)).not.have.property('replies');
  });
});

describe('attention route discuss', () => {
  it('should let the owner ask to discuss an item, keeping it open and marking it waiting on the ferret', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));

    // Act
    const discussed = await dispatch(post({ action: 'discuss', id: 'A1', note: 'Let us talk it through' }));

    // Assert
    should(discussed.status).equal(200);
    should((jsonBody(discussed).items as readonly unknown[])[0]).containDeep({
      id: 'A1',
      waitingOn: 'ferret',
      waitingFor: 'discussion',
      infoRequests: 1,
    });
  });

  it('should refuse the ferret discussing its own item and an unknown item', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));

    // Act
    const byAgent = await dispatch(post({ action: 'discuss', id: 'A1' }, agentIn('s1')));
    const unknown = await dispatch(post({ action: 'discuss', id: 'A9' }));

    // Assert
    should(byAgent.status).equal(403);
    should(unknown.status).equal(404);
  });
});

describe('attention route needs-info', () => {
  const task = {
    action: 'add',
    subject: 'Log in to the cloud',
    why: 'The deploy needs it',
    howToResolve: 'Follow the steps',
    ask: { kind: 'task' },
    steps: ['Run the login'],
  } as const;

  it('should let the owner ask for more information, keep the item open and mark it waiting on the ferret', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(task, agentIn('s1')));

    // Act
    const asked = await dispatch(post({ action: 'needs-info', id: 'A1', note: 'Which account?' }));

    // Assert
    should(asked.status).equal(200);
    should(jsonBody(asked)).containDeep({ count: 1 });
    should((jsonBody(asked).items as readonly unknown[])[0]).containDeep({
      id: 'A1',
      waitingOn: 'ferret',
      infoRequests: 1,
    });
  });

  it('should refuse the ferret asking itself, an unknown item and a closed one', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(task, agentIn('s1')));
    await dispatch(post({ action: 'resolve', id: 'A1' }));

    // Act
    const byAgent = await dispatch(post({ action: 'needs-info', id: 'A1' }, agentIn('s1')));
    const unknown = await dispatch(post({ action: 'needs-info', id: 'A9' }));
    const closed = await dispatch(post({ action: 'needs-info', id: 'A1' }));

    // Assert
    should(byAgent.status).equal(403);
    should(unknown.status).equal(404);
    should(closed.status).equal(404);
  });

  it('should answer a ferret edit that answers the request with the cleared mark, and lint what it wrote', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(task, agentIn('s1')));
    await dispatch(post({ action: 'needs-info', id: 'A1' }));

    // Act
    const edited = await dispatch(
      post({ action: 'edit', id: 'A1', subject: 'Log in to ABC-123 via https://example.com' }, agentIn('s1')),
    );

    // Assert
    should(edited.status).equal(200);
    should((jsonBody(edited).items as readonly Record<string, unknown>[])[0]).not.have.property('waitingOn');
    should(jsonBody(edited)).have.property('warnings');
  });
});

describe('attention route surface', () => {
  it('should let a ferret surface an item the owner took into discussion, and keep surface idempotent', async () => {
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    await dispatch(post({ action: 'discuss', id: 'A1', note: 'Let us talk it through' }));

    // Act
    const surfaced = await dispatch(
      post({ action: 'surface', id: 'A1', why: 'Still open: the branch' }, agentIn('s1')),
    );
    const again = await dispatch(post({ action: 'surface', id: 'A1' }, agentIn('s1')));

    // Assert — a new ask is the owner's turn, not the ferret's.
    should((jsonBody(raised).items as readonly Record<string, unknown>[])[0]).not.have.property('waitingOn');
    should(surfaced.status).equal(200);
    const [item] = jsonBody(surfaced).items as readonly {
      waitingOn?: string;
      history: { kind: string; note?: string }[];
    }[];
    should(item).not.have.property('waitingOn');
    should(item?.history.at(-1)).containDeep({ kind: 'surfaced', note: 'Still open: the branch' });
    should(again.status).equal(200);
  });

  it('should let the owner surface it, refuse another ferret and an unknown item, and leave a closed one alone', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));
    await dispatch(post({ ...raise, subject: 'second' }, agentIn('s1')));

    // Act
    const other = await dispatch(post({ action: 'surface', id: 'A1' }, agentIn('s2')));
    const unknown = await dispatch(post({ action: 'surface', id: 'A9' }));
    const owner = await dispatch(post({ action: 'surface', id: 'A2' }));
    await dispatch(post({ action: 'resolve', id: 'A1' }));
    const closed = await dispatch(post({ action: 'surface', id: 'A1' }));

    // Assert
    should(other.status).equal(403);
    should(unknown.status).equal(404);
    should(owner.status).equal(200);
    should(closed.status).equal(200);
  });
});

describe('attention route add: the agenda fields, notices and the old surface flag', () => {
  const items = (response: ApiResponse) => jsonBody(response).items as readonly Record<string, unknown>[];
  const notice = {
    action: 'add',
    notice: true,
    title: 'CI is green',
    subject: 'CI is green on main',
    why: 'The release branch builds again.',
    howToResolve: 'Nothing to do.',
  } as const;

  it('should accept and ignore the old surface flag: a new ask is the owner’s turn either way', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const withFlag = await dispatch(post({ ...raise, surface: true }, agentIn('s1')));
    const without = await dispatch(post({ ...raise, subject: 'second' }, agentIn('s1')));

    // Assert
    should(withFlag.status).equal(200);
    should(items(withFlag)[0]).not.have.property('waitingOn');
    should(items(without).find(item => item.subject === 'second')).not.have.property('waitingOn');
  });

  it('should take a notice and a ping from a ferret, and keep the notice off the owner’s turn', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const plain = await dispatch(post(notice, agentIn('s1')));
    const pinged = await dispatch(post({ ...notice, subject: 'a second notice', ping: true }, agentIn('s1')));

    // Assert
    should(plain.status).equal(200);
    should(items(plain)[0]).containDeep({ notice: true });
    should(items(plain)[0]).not.have.property('waitingOn');
    should(pinged.status).equal(200);
    should(items(pinged).find(item => item.subject === 'a second notice')).containDeep({ notice: true, ping: true });
  });

  it('should refuse a notice from the owner, and one that carries an ask, answers, steps or a kind other than info', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const byHuman = await dispatch(post(notice));
    const withAsk = await dispatch(post({ ...notice, ask: { kind: 'open-question' } }, agentIn('s1')));
    const withAnswers = await dispatch(post({ ...notice, answers: [{ label: 'ok' }] }, agentIn('s1')));
    const withSteps = await dispatch(post({ ...notice, steps: ['Run it'] }, agentIn('s1')));
    const wrongKind = await dispatch(post({ ...notice, kind: 'task' }, agentIn('s1')));

    // Assert
    should(byHuman.status).equal(403);
    for (const refused of [withAsk, withAnswers, withSteps, wrongKind]) should(refused.status).equal(400);
    should(jsonBody(withAsk).error).containEql('a notice has no ask');
    should(jsonBody(withSteps).error).containEql('a notice has no steps');
    should(jsonBody(wrongKind).error).containEql('a notice is kind info');
  });

  it('should refuse a ping on anything but a notice, and a key the request does not know', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const ping = await dispatch(post({ ...raise, ping: true }, agentIn('s1')));
    const unknown = await dispatch(post({ ...raise, urgentNow: true }, agentIn('s1')));
    const falseNotice = await dispatch(post({ ...notice, notice: false }, agentIn('s1')));

    // Assert
    should(ping.status).equal(400);
    should(jsonBody(ping).error).containEql('ping is only for a notice');
    should(unknown.status).equal(400);
    should(falseNotice.status).equal(400);
  });

  it('should keep the agenda fields a raise names', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const raised = await dispatch(
      post(
        { ...raise, blockingNow: true, willBlock: 'the deploy', neededBy: '2026-12-01T09:00:00.000Z' },
        agentIn('s1'),
      ),
    );

    // Assert
    should(items(raised)[0]).containDeep({
      blockingNow: true,
      willBlock: 'the deploy',
      neededBy: '2026-12-01T09:00:00.000Z',
    });
  });
});

describe('attention route edit: clearing agenda fields', () => {
  const items = (response: ApiResponse) => jsonBody(response).items as readonly Record<string, unknown>[];
  const agenda = {
    ...raise,
    blockingNow: true,
    willBlock: 'the deploy',
    neededBy: '2026-12-01T09:00:00.000Z',
  } as const;

  it('should clear the fields an edit names and leave the others', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(agenda, agentIn('s1')));

    // Act
    const cleared = await dispatch(
      post({ action: 'edit', id: 'A1', clear: ['blockingNow', 'neededBy'] }, agentIn('s1')),
    );

    // Assert
    should(cleared.status).equal(200);
    should(items(cleared)[0]).not.have.property('blockingNow');
    should(items(cleared)[0]).not.have.property('neededBy');
    should(items(cleared)[0]).containDeep({ willBlock: 'the deploy' });
  });

  it('should clear one field while it sets another in the same edit', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(agenda, agentIn('s1')));

    // Act
    const edited = await dispatch(
      post({ action: 'edit', id: 'A1', willBlock: 'the release', clear: ['neededBy'] }, agentIn('s1')),
    );

    // Assert
    should(edited.status).equal(200);
    should(items(edited)[0]).containDeep({ willBlock: 'the release', blockingNow: true });
    should(items(edited)[0]).not.have.property('neededBy');
  });

  it('should refuse a field both set and cleared, an empty or unknown clear list, and a key it does not know', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(agenda, agentIn('s1')));

    // Act
    const both = await dispatch(
      post({ action: 'edit', id: 'A1', willBlock: 'x', clear: ['willBlock'] }, agentIn('s1')),
    );
    const empty = await dispatch(post({ action: 'edit', id: 'A1', clear: [] }, agentIn('s1')));
    const unknownField = await dispatch(post({ action: 'edit', id: 'A1', clear: ['title'] }, agentIn('s1')));
    const unknownKey = await dispatch(post({ action: 'edit', id: 'A1', clearAll: true }, agentIn('s1')));

    // Assert
    should(both.status).equal(400);
    should(jsonBody(both).error).containEql('willBlock cannot be set and cleared at once');
    should(empty.status).equal(400);
    should(unknownField.status).equal(400);
    should(unknownKey.status).equal(400);
  });
});

describe('attention route progress', () => {
  const task = {
    action: 'add',
    subject: 'Log in to the cloud',
    why: 'The deploy needs it',
    howToResolve: 'Follow the steps',
    ask: { kind: 'task' },
    steps: ['Run the login', 'Confirm the account'],
  } as const;

  it('should tick and untick a step on the open item without closing it', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(task, agentIn('s1')));

    // Act
    const ticked = await dispatch(post({ action: 'progress', id: 'A1', step: 1, done: true }));
    const unticked = await dispatch(post({ action: 'progress', id: 'A1', step: 1, done: false }));

    // Assert
    should(ticked.status).equal(200);
    should((jsonBody(ticked).items as readonly unknown[])[0]).containDeep({ id: 'A1', stepsDone: [1] });
    should(unticked.status).equal(200);
    should((jsonBody(unticked).items as readonly Record<string, unknown>[])[0]).not.have.property('stepsDone');
  });

  it('should refuse a step the item does not have', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(task, agentIn('s1')));

    // Act
    const response = await dispatch(post({ action: 'progress', id: 'A1', step: 5, done: true }));

    // Assert
    should(response.status).equal(400);
  });
});
