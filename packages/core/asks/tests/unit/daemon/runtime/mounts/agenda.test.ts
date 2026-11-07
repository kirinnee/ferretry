import { describe, it } from 'bun:test';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { type ApiCredentials, ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../../../daemon/lib/agenda/index.ts';
import { agendaActor, agendaRoutes, type DirectNotificationSubsystem } from '../../../../src/lib/runtime/index.ts';
import type { AgendaGatePort } from '../../../../../daemon/lib/runtime/mounts/agenda-gates.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  agentIn,
  agendaService,
  CREDENTIALS,
  FERRET_ARRIVAL,
  FakeLedgerRepository,
  FERRET_SESSION,
  ferretOwn,
  human,
  NO_HELD_REPLIES,
} from './support.ts';

/** A repository whose reads fail the way a damaged ledger file does. */
class BrokenLedgerRepository implements AgendaLedgerRepository {
  async read(): Promise<AgendaLedger | null> {
    throw new Error('the ledger on disk is not decodable');
  }

  async transact(): Promise<AgendaMutation> {
    return { ok: false, error: { code: 'corrupt', message: 'the ledger on disk is not decodable' } };
  }
}

class FakeNotifications implements DirectNotificationSubsystem {
  enrolled: number | Error = 2;

  async enrolledDevices(): Promise<number> {
    if (this.enrolled instanceof Error) throw this.enrolled;
    return this.enrolled;
  }
}

function fixture(
  repository?: AgendaLedgerRepository,
  notifications: DirectNotificationSubsystem = new FakeNotifications(),
  credentials: ApiCredentials = CREDENTIALS,
  gates?: AgendaGatePort,
) {
  const routes = agendaRoutes(agendaService(repository), notifications, NO_HELD_REPLIES, undefined, gates);
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), credentials, NO_GOVERNED_ROUTES_GUARD);
  return async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
    await dispatcher.dispatch(request(overrides));
}

const post = (body: unknown, headers: Readonly<Record<string, string>> = human) => ({
  method: 'POST',
  path: '/v1/sessions/s1/agenda',
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
  premise: 'A ferret needs the owner.',
  context: 'The work waits on this answer.',
  howToResolve: 'name the branch to target',
  ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'develop' }] },
} as const;

describe('agendaActor', () => {
  it('should accept only established peer, admin, or paired-device provenance', () => {
    // Arrange / Act / Assert
    should(agendaActor('peer:s1')).deepEqual({ kind: 'agent', sessionId: 's1', name: null });
    should(agendaActor('admin-cli')).deepEqual({ kind: 'human' });
    should(agendaActor('admin-ui')).deepEqual({ kind: 'human' });
    should(agendaActor('device:browser-1')).deepEqual({ kind: 'human' });
    for (const unavailable of ['peer:', 'peer:not/a/session', 'device:', 'warden:s1', 'unknown', undefined]) {
      should(() => agendaActor(unavailable)).throw(/established human or session provenance/u);
    }
  });
});

describe('agenda routes', () => {
  it('should answer an empty board rather than a 404 for a session with no ledger yet', async () => {
    // A session that has never blocked has an empty board, which is not the same as a missing one.
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/agenda', headers: human });

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

  it('should take a body of exactly 200,000 characters and refuse 200,001 with the count and the remedy', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const exact = await dispatch(post({ ...raise, body: 'x'.repeat(200_000) }, agentIn('s1')));
    const over = await dispatch(post({ ...raise, body: 'x'.repeat(200_001) }, agentIn('s1')));

    // Assert
    should(exact.status).equal(200);
    should(over.status).equal(400);
    should(JSON.stringify(jsonBody(over)))
      .match(/the body is 200,001 characters; the most is 200,000\. Do not trim it/u)
      .match(/add it with --link/u);
  });

  it('should hold an edit’s body and question answer to the same 200,000 characters', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));
    const edit = (fields: object) => post({ action: 'edit', id: 'A1', ...fields }, agentIn('s1'));

    // Act
    const body = await dispatch(edit({ body: 'x'.repeat(200_001) }));
    const answer = await dispatch(edit({ questionAnswer: 'x'.repeat(200_001) }));
    const fits = await dispatch(edit({ questionAnswer: 'x'.repeat(200_000) }));

    // Assert
    should(body.status).equal(400);
    should(JSON.stringify(jsonBody(body))).match(/the body is 200,001 characters; the most is 200,000/u);
    should(answer.status).equal(400);
    should(JSON.stringify(jsonBody(answer))).match(/the question answer is 200,001 characters; the most is 200,000/u);
    should(fits.status).equal(200);
  });

  it('should refuse a ferret’s new item with no premise or no context, naming what is missing', async () => {
    // Arrange
    const dispatch = fixture();
    const { premise: _premise, context: _context, ...bare } = raise;

    // Act
    const neither = await dispatch(post(bare, agentIn('s1')));
    const noContext = await dispatch(post({ ...bare, premise: 'A ferret needs the owner.' }, agentIn('s1')));
    const blank = await dispatch(post({ ...raise, premise: '   ' }, agentIn('s1')));

    // Assert
    should(neither.status).equal(400);
    should(JSON.stringify(jsonBody(neither)))
      .match(/premise \(--premise\) is required/u)
      .match(/context \(--context\)/u);
    should(noContext.status).equal(400);
    should(JSON.stringify(jsonBody(noContext)))
      .match(/context \(--context\) is required/u)
      .not.match(/premise \(--premise/u);
    should(blank.status).equal(400);
  });

  it('should let a ferret’s notice go without a premise or a context', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch(
      post(
        {
          action: 'add',
          subject: 'Build is green',
          why: 'FYI',
          howToResolve: 'Nothing to do.',
          kind: 'info',
          notice: true,
        },
        agentIn('s1'),
      ),
    );

    // Assert
    should(response.status).equal(200);
  });

  it('should warn, never refuse, a human’s decision raised with no premise and no context', async () => {
    // Arrange: only a ferret must give them; an item the owner raises is still only warned about
    const dispatch = fixture();
    const { premise: _premise, context: _context, ...bare } = raise;

    // Act
    const response = await dispatch(post(bare));

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

  it('should take an item on for its ferret with rest, quiet, as working', async () => {
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;

    // Act
    const rested = await dispatch(post({ action: 'rest', id, why: 'checking both branches' }, agentIn('s1')));

    // Assert
    should(rested.status).equal(200);
    const items = jsonBody(rested).items as readonly { resting?: { sub: string; why?: string } }[];
    should(items[0]?.resting).containDeep({ sub: 'working', why: 'checking both branches' });
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
      post({ action: 'resolve', id, response: { kind: 'multiple-choice', choice: 'main' } }, human),
    );

    // Assert — a ferret's item RESTS on the owner's answer (docs/agenda.md § States): still open, the choice on it.
    should(answered.status).equal(200);
    const items = jsonBody(answered).items as readonly {
      ownerAnswer?: { response?: { choice?: string } };
      parked?: { reason: string };
      resting?: { sub: string };
    }[];
    should(jsonBody(answered).resolved).be.empty();
    should(items[0]?.ownerAnswer?.response?.choice).equal('main');
    should(items[0]?.parked?.reason).equal('replied');
    should(items[0]?.resting?.sub).equal('waiting-on-ferret');
  });

  it('should refuse an answer to an ask the ferret has since replaced, 409 ask_changed', async () => {
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;
    const replaced = await dispatch(
      post(
        { action: 'edit', id, ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'dev' }] } },
        agentIn('s1'),
      ),
    );

    // Act
    const stale = await dispatch(
      post({ action: 'resolve', id, askVersion: 1, response: { kind: 'multiple-choice', choice: 'main' } }),
    );
    const current = await dispatch(
      post({ action: 'resolve', id, askVersion: 2, response: { kind: 'multiple-choice', choice: 'dev' } }),
    );

    // Assert
    should(replaced.status).equal(200);
    should(stale.status).equal(409);
    should(jsonBody(stale)).have.property('code', 'ask_changed');
    should(current.status).equal(200);
  });

  it('should refuse a Done or Skip given from an ask the ferret has since replaced, 409 ask_changed', async () => {
    // Arrange — the owner's Mark as done is held in the undo window while the ferret replaces the ask
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;
    await dispatch(
      post(
        { action: 'edit', id, ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'dev' }] } },
        agentIn('s1'),
      ),
    );

    // Act
    const staleDone = await dispatch(post({ action: 'resolve', id, askVersion: 1 }));
    const staleSkip = await dispatch(post({ action: 'dismiss', id, askVersion: 1 }));
    const current = await dispatch(post({ action: 'dismiss', id, askVersion: 2 }));

    // Assert — the stale closes leave the new question open; one that names the current ask closes it
    should(staleDone.status).equal(409);
    should(jsonBody(staleDone)).have.property('code', 'ask_changed');
    should(staleSkip.status).equal(409);
    should(current.status).equal(200);
    should(jsonBody(current).items as readonly unknown[]).be.empty();
  });

  it('should close the item as it stands on a Done that names no ask, after the ferret replaced it', async () => {
    // Arrange
    const dispatch = fixture();
    const raised = await dispatch(post(raise, agentIn('s1')));
    const id = (jsonBody(raised).items as readonly { id: string }[])[0]?.id;
    await dispatch(
      post(
        { action: 'edit', id, ask: { kind: 'multiple-choice', options: [{ label: 'main' }, { label: 'dev' }] } },
        agentIn('s1'),
      ),
    );

    // Act
    const explicit = await dispatch(post({ action: 'resolve', id }));

    // Assert
    should(explicit.status).equal(200);
    should(jsonBody(explicit).items as readonly unknown[]).be.empty();
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
    // The owner may reply in words instead of picking; the note carries them to the ferret (docs/agenda.md).
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

  it('should act for a ferret on its own credential as THAT session: never another, never the owner', async () => {
    // Arrange — the credential names the session; the request sends no session header at all.
    const dispatch = fixture();
    const asFerret = (body: unknown, sessionId: string) => ({
      ...post(body, ferretOwn),
      ...FERRET_ARRIVAL,
      path: `/v1/sessions/${sessionId}/agenda`,
    });
    const ownersItem = await dispatch({ ...post(raise), path: `/v1/sessions/${FERRET_SESSION}/agenda` });
    const ownersId = (jsonBody(ownersItem).items as readonly { id: string }[])[0]?.id;

    // Act
    const own = await dispatch(asFerret({ ...raise, subject: 'its own ask' }, FERRET_SESSION));
    const another = await dispatch(asFerret(raise, 's1'));
    const theOwners = await dispatch(asFerret({ action: 'dismiss', id: ownersId }, FERRET_SESSION));

    // Assert
    should(own.status).equal(200);
    should((jsonBody(own).items as readonly { raisedBy: string; raisedBySession?: string }[]).at(-1)).containDeep({
      raisedBy: 'agent',
      raisedBySession: FERRET_SESSION,
    });
    should([another.status, jsonBody(another).code]).deepEqual([403, 'forbidden']);
    should([theOwners.status, jsonBody(theOwners).code]).deepEqual([403, 'forbidden']);
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
    const response = await dispatch({ path: '/v1/sessions/not a session/agenda', headers: human });

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response)).have.property('code', 'invalid');
  });

  it('should refuse a path session id that decodes to a traversal step', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/%2e%2e/agenda', headers: human });

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
    const listed = await dispatch({ path: '/v1/sessions/s1/agenda', headers: human });
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
      path: '/v1/sessions/s1/agenda',
      headers: { authorization: `Bearer ${CREDENTIALS.warden}` },
    });

    // Assert
    should(response.status).equal(403);
  });

  it('should answer 401 without a token at all', async () => {
    // Arrange
    const dispatch = fixture();

    // Act
    const response = await dispatch({ path: '/v1/sessions/s1/agenda' });

    // Assert
    should(response.status).equal(401);
  });
});

describe('agenda routes and held answers', () => {
  it('should serve the board without `replies` when the outbox cannot be read', async () => {
    // Arrange
    const routes = agendaRoutes(agendaService(), new FakeNotifications(), {
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
    const response = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/agenda', headers: human }));

    // Assert — the board is the answer; a held outbox is decoration.
    should(response.status).equal(200);
    should(jsonBody(response)).not.have.property('replies');
    should(jsonBody(response)).not.have.property('delivery');
  });

  it('should serve the answers on their way as `delivery`, beside the held ones', async () => {
    // Arrange
    const routes = agendaRoutes(agendaService(), new FakeNotifications(), {
      pending: async () => undefined,
      delivery: async () => ({ sending: ['A2'], heldForComposer: true }),
      sendNow: async () => undefined,
    });
    const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

    // Act
    const response = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/agenda', headers: human }));

    // Assert — "Sending…" is told from the board itself.
    should(response.status).equal(200);
    should(jsonBody(response))
      .have.property('delivery')
      .deepEqual({ sending: ['A2'], heldForComposer: true });
    should(jsonBody(response)).not.have.property('replies');
  });
});

describe('agenda route discuss', () => {
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

describe('agenda route needs-info', () => {
  const task = {
    action: 'add',
    subject: 'Log in to the cloud',
    why: 'The deploy needs it',
    premise: 'A ferret needs the owner.',
    context: 'The work waits on this answer.',
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

describe('agenda route surface', () => {
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

describe('agenda route add: the agenda fields, notices and the old surface flag', () => {
  const items = (response: ApiResponse) => jsonBody(response).items as readonly Record<string, unknown>[];
  const notice = {
    action: 'add',
    notice: true,
    title: 'CI is green',
    subject: 'CI is green on main',
    why: 'The release branch builds again.',
    premise: 'A ferret needs the owner.',
    context: 'The work waits on this answer.',
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

describe('agenda route edit: clearing agenda fields', () => {
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

  it('should accept back on an edit and leave an item that was never replied to as it was', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(agenda, agentIn('s1')));

    // Act
    const edited = await dispatch(
      post({ action: 'edit', id: 'A1', willBlock: 'the release', back: true }, agentIn('s1')),
    );

    // Assert
    should(edited.status).equal(200);
    should(items(edited)[0]).containDeep({ willBlock: 'the release' });
    should(items(edited)[0]).not.have.property('parked');
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

describe('agenda route progress', () => {
  const task = {
    action: 'add',
    subject: 'Log in to the cloud',
    why: 'The deploy needs it',
    premise: 'A ferret needs the owner.',
    context: 'The work waits on this answer.',
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

describe('agenda route snooze', () => {
  const until = '2024-05-02T10:00:00.000Z';
  const items = (response: ApiResponse) => jsonBody(response).items as readonly Record<string, unknown>[];

  it('should let the owner snooze an item until a time and bring it back, answering the board each time', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));

    // Act
    const snoozed = await dispatch(post({ action: 'snooze', id: 'A1', until }));
    const unsnoozed = await dispatch(post({ action: 'unsnooze', id: 'A1' }));

    // Assert
    should(snoozed.status).equal(200);
    should(items(snoozed)[0]).containDeep({ id: 'A1', parked: { reason: 'snoozed', until } });
    should(unsnoozed.status).equal(200);
    should(items(unsnoozed)[0]).not.have.property('parked');
  });

  it('should refuse a ferret snoozing, a time already past, and an unknown item', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));

    // Act
    const byAgent = await dispatch(post({ action: 'snooze', id: 'A1', until }, agentIn('s1')));
    const past = await dispatch(post({ action: 'snooze', id: 'A1', until: '2024-04-30T10:00:00.000Z' }));
    const unknown = await dispatch(post({ action: 'snooze', id: 'A9', until }));
    const unparkedByAgent = await dispatch(post({ action: 'unsnooze', id: 'A1' }, agentIn('s1')));

    // Assert
    should(byAgent.status).equal(403);
    should(past.status).equal(400);
    should(unknown.status).equal(404);
    should(unparkedByAgent.status).equal(403);
  });

  it('should keep a snoozed item parked through a ferret’s edit, and let `now` wake it once an hour', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));
    await dispatch(post({ action: 'snooze', id: 'A1', until }));

    // Act
    const quiet = await dispatch(
      post({ action: 'edit', id: 'A1', subject: 'which of three base branches?' }, agentIn('s1')),
    );
    const urgent = await dispatch(
      post({ action: 'edit', id: 'A1', subject: 'production is down', now: true }, agentIn('s1')),
    );
    await dispatch(post({ action: 'snooze', id: 'A1', until }));
    const again = await dispatch(post({ action: 'edit', id: 'A1', subject: 'still down', now: true }, agentIn('s1')));

    // Assert
    should(quiet.status).equal(200);
    should(items(quiet)[0]).containDeep({ subject: 'which of three base branches?', parked: { reason: 'snoozed' } });
    should(urgent.status).equal(200);
    should(items(urgent)[0]).containDeep({ subject: 'production is down', urgentAt: '2024-05-01T10:00:00.000Z' });
    should(items(urgent)[0]).not.have.property('parked');
    should(items(urgent)[0]).not.have.property('now');
    should(again.status).equal(429);
  });

  it('should let a ferret surface a snoozed item with `now`, once an hour', async () => {
    // Arrange
    const dispatch = fixture();
    await dispatch(post(raise, agentIn('s1')));
    await dispatch(post({ action: 'snooze', id: 'A1', until }));

    // Act
    const quiet = await dispatch(post({ action: 'surface', id: 'A1', why: 'still waiting' }, agentIn('s1')));
    const urgent = await dispatch(post({ action: 'surface', id: 'A1', why: 'it is urgent', now: true }, agentIn('s1')));
    await dispatch(post({ action: 'snooze', id: 'A1', until }));
    const again = await dispatch(post({ action: 'surface', id: 'A1', now: true }, agentIn('s1')));

    // Assert
    should(items(quiet)[0]).containDeep({ parked: { reason: 'snoozed' } });
    should(urgent.status).equal(200);
    should(items(urgent)[0]).containDeep({ urgentAt: '2024-05-01T10:00:00.000Z' });
    should(items(urgent)[0]).not.have.property('parked');
    should(again.status).equal(429);
  });
});

it('reads stored conversation through the mounted operator route and refuses invalid cursors', async () => {
  // Arrange
  const dispatch = fixture();
  await dispatch(post(raise, agentIn('s1')));
  await dispatch(post({ action: 'resolve', id: 'A1', response: { kind: 'other', answer: 'Use eu-west, please.' } }));

  // Act
  const response = await dispatch({ path: '/v1/sessions/s1/agenda/A1/conversation', headers: human });
  const invalid = await dispatch({
    path: '/v1/sessions/s1/agenda/A1/conversation',
    headers: human,
    query: [['offset', '-1']],
  });

  // Assert
  should(response.status).equal(200);
  should(jsonBody(response)).containDeep({
    total: 1,
    index: 0,
    offset: 0,
    entry: { by: 'owner', text: 'Use eu-west, please.', via: 'answer' },
  });
  should(response.headers.get('cache-control')).equal('no-store');
  should(invalid.status).equal(400);
});

it('serves full versions, per-device seen marks and conversation mutations through the real route handlers', async () => {
  // Arrange
  const at = '2026-11-03T10:00:00.000Z';
  const summary = { version: 1, at, by: 'ferret' as const, change: 'created', lifecycle: 'active' as const };
  const item = {
    id: 'A1',
    source: 'agent-raised' as const,
    sourceRef: null,
    subject: 'Which region?',
    why: 'A deploy is ready.',
    waitingSince: at,
    howToResolve: 'Choose a region.',
    ask: { kind: 'open-question' as const },
    raisedBy: 'agent' as const,
    raisedBySession: 's1',
    raisedByName: null,
  };
  const service = new AgendaService(
    new FakeLedgerRepository(),
    { now: () => at },
    { has: async id => id === 's1' },
    { raised: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      find: async (_session, messageId) => ({
        ok: true,
        message: { messageId: messageId ?? 'owner-1', at, text: '    Use eu-west.\n' },
      }),
    },
    {
      record: async () => undefined,
      list: async () => [summary],
      get: async (_session, id, version) => (id === 'A1' && version === 1 ? { ...summary, item } : undefined),
    },
    { seen: async () => 1, mark: async (_session, _id, _device, version) => version },
  );
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaRoutes(service, new FakeNotifications(), NO_HELD_REPLIES)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const dispatch = (input: Parameters<typeof request>[0]) => dispatcher.dispatch(request(input));

  // Act and assert: version reads and cursor errors.
  const listed = await dispatch({ path: '/v1/sessions/s1/agenda/A1/versions', headers: human });
  should(listed.status).equal(200);
  should(jsonBody(listed)).containDeep({ latest: 1, seen: 1, versions: [summary] });
  const phone = await dispatch({
    path: '/v1/sessions/s1/agenda/A1/versions',
    device: { deviceId: 'phone', appSession: 'app' },
  });
  should(phone.status).equal(200);
  const version = await dispatch({ path: '/v1/sessions/s1/agenda/A1/versions/1', headers: human });
  should(version.status).equal(200);
  should(jsonBody(version)).containDeep({ version: 1, item: { subject: item.subject } });
  for (const [path, status] of [
    ['/v1/sessions/s1/agenda/A1/versions/nope', 400],
    ['/v1/sessions/s1/agenda/nope/versions', 400],
    ['/v1/sessions/s1/agenda/A1/versions/2', 404],
    ['/v1/sessions/missing/agenda/A1/versions', 404],
    ['/v1/sessions/missing/agenda/A1/versions/1', 404],
  ] as const)
    should((await dispatch({ path, headers: human })).status).equal(status);
  const marked = await dispatch({
    method: 'PUT',
    path: '/v1/sessions/s1/agenda/A1/seen',
    headers: human,
    body: '{"version":1}',
  });
  should(marked.status).equal(200);
  should(jsonBody(marked)).deepEqual({ seen: 1 });
  should(
    (await dispatch({ method: 'PUT', path: '/v1/sessions/s1/agenda/A1/seen', headers: human, body: '{"version":2}' }))
      .status,
  ).equal(400);
  const emptyList = await fixture()({ path: '/v1/sessions/s1/agenda/A1/versions', headers: human });
  should(jsonBody(emptyList)).containDeep({ latest: 0, versions: [] });

  // The shipped mutation verbs run through the parsed API boundary, with source text held by the daemon.
  for (const subject of ['Which region?', 'Which quota?'])
    should((await dispatch(post({ ...raise, subject }, agentIn('s1')))).status).equal(200);
  should(
    (await dispatch(post({ action: 'log', id: 'A1', mode: 'reply', text: 'OK', messageId: 'owner-1' }, agentIn('s1'))))
      .status,
  ).equal(200);
  should((await dispatch(post({ action: 'merge', id: 'A1', from: 'A2' }, agentIn('s1')))).status).equal(200);
  const split = await dispatch(
    post(
      {
        action: 'split',
        id: 'A1',
        item: {
          subject: 'Which cache?',
          title: 'Cache',
          why: 'A cache is needed.',
          premise: 'A cache is needed.',
          context: 'Cache rollout has its own schedule.',
          howToResolve: 'Pick a cache.',
          ask: { kind: 'open-question' },
        },
      },
      agentIn('s1'),
    ),
  );
  should(split.status).equal(200);
  should(jsonBody(split).items).containDeep([{ id: 'A3', splitFrom: 'A1' }]);
});
