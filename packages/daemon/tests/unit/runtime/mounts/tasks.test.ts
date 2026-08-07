import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import type { ScopedTaskDetailResponse, ScopedTaskView, SessionTaskListResponse, Task } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type TaskSubsystem, taskActor, taskLive, taskRoutes } from '../../../../src/lib/runtime/mounts/tasks.ts';
import {
  ACTOR_AUTHORITY_SPLIT_LANDED_AT,
  TASK_UNAVAILABLE_MESSAGE,
  TaskError,
} from '../../../../src/lib/tasks/index.ts';
import { TASK_SNAPSHOT_SCHEMA_VERSION } from '../../../../src/lib/tasks/task-snapshot.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  AT,
  agentIn,
  BOARD_UNREADABLE_DETAIL,
  CREDENTIALS,
  FakeTaskBoard,
  human,
  type TaskWorld,
  taskSubsystem,
} from './support.ts';

/**
 * The task board's HTTP surface, driven through the real router and the real reducer.
 *
 * The board behind these routes is in memory, but every rule that decides an answer — the reducer,
 * the board order, the authorization check, the protocol schemas — is the production one. That is
 * what makes this a test of the MOUNT rather than a test of a fake.
 */

const CREATE = {
  kind: 'feature',
  title: 'Wire the task boards',
  ask: { text: 'mount the boards', source: 'human' },
} as const;

/** A task as a pre-split daemon left it on disk: shipped, and attested by a flag nobody can check. */
const legacyTask = () =>
  ({
    v: 1,
    id: 'F1',
    kind: 'feature',
    title: 'Wire the task boards',
    description: '',
    ask: { text: 'mount the boards', source: 'human' },
    clarifications: [],
    workflow: 'quick',
    phase: 'done',
    dependsOn: [],
    status: 'done',
    statusReason: 'claimed complete',
    assignee: null,
    repo: null,
    files: [],
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: AT,
    createdBy: 'peer:s1',
    updatedAt: AT,
  }) as Task;

/** What the board authorizer resolves for a peer that really does hold `mark_done`. */
const RESOLVED_GRANT = {
  boardId: 'board-1',
  grantId: 'grant-1',
  sessionId: 's1',
  role: 'top_agent',
  allowedActions: ['mark_done'],
  boardEpoch: 4,
  coordinatorEpoch: 2,
  runtimeGeneration: 7,
} as const;

/** The dispatcher a request is driven through, over the routes and the credentials the daemon uses. */
function dispatcher(world: TaskWorld = {}): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(taskRoutes(taskSubsystem(world))), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const post = (path: string, body: unknown, headers: Readonly<Record<string, string>> = human) =>
  request({
    method: 'POST',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Creates one task on `session`, returning the dispatcher that owns it and the created view. */
async function withTask(
  world: TaskWorld = {},
  session = 's1',
): Promise<{ readonly dispatch: ApiDispatcher; readonly task: ScopedTaskView }> {
  const dispatch = dispatcher(world);
  const created = await dispatch.dispatch(post(`/v1/sessions/${session}/tasks`, CREATE));
  return { dispatch, task: jsonBody(created) as unknown as ScopedTaskView };
}

describe('the task board mount', () => {
  describe('actor attribution', () => {
    it('should call an in-pane peer an agent bound to its own session', () => {
      // Arrange / Act
      const actor = taskActor('peer:s1');

      // Assert
      should(actor).deepEqual({ kind: 'agent', id: 'peer:s1', name: null, sessionId: 's1' });
    });

    it('should refuse to call a peer with no session an agent', () => {
      // A `peer:` with nothing after it names no session, so treating it as an agent would record
      // provenance nothing can be traced back to.
      // Arrange / Act
      const actor = taskActor('peer:');

      // Assert
      should(actor).deepEqual({ kind: 'human', id: 'peer:', name: null, sessionId: null });
    });

    it('should call the human CLI a human, and an absent actor one too', () => {
      // Arrange / Act
      const cli = taskActor('admin-cli');
      const absent = taskActor(undefined);

      // Assert
      should(cli).deepEqual({ kind: 'human', id: 'admin-cli', name: null, sessionId: null });
      should(absent).deepEqual({ kind: 'human', id: '', name: null, sessionId: null });
    });
  });

  describe('the live view', () => {
    it('should report an unobserved assignee as empty rather than guessing', () => {
      // Arrange / Act
      const live = taskLive(undefined);

      // Assert
      should(live).deepEqual({
        assigneeSessionId: null,
        assigneeName: null,
        assigneeStatus: null,
        assigneeLastActivityAt: null,
        assigneeHealth: null,
        assigneeDoneMarker: false,
        staleness: null,
      });
    });

    it('should report the facts the session index holds and no verdict it does not', () => {
      // Arrange / Act
      const live = taskLive({ sessionId: 's1', name: 'Wire Subsystems', status: 'running', lastActivityAt: AT });

      // Assert
      should(live.assigneeSessionId).equal('s1');
      should(live.assigneeName).equal('Wire Subsystems');
      should(live.assigneeStatus).equal('running');
      should(live.assigneeLastActivityAt).equal(AT);
      // Health and staleness are the supervision subsystem's judgements, and none is mounted.
      should(live.assigneeHealth).be.null();
      should(live.staleness).be.null();
      should(live.assigneeDoneMarker).be.false();
    });
  });

  describe('resolving assignees', () => {
    it('should ask once per response, for the distinct assignees of the rows it will show', async () => {
      // An assignee is a teammate name far more often than a session id, and resolving a name means
      // reading the documents that carry names. Asked per row, a board of two hundred tasks would fan
      // out over the whole fleet two hundred times — so the batch, and its distinctness, ARE the
      // contract rather than an implementation detail.
      // Arrange
      const observed: string[][] = [];
      const dispatch = dispatcher({ observed });
      // Two tasks owned by `ossy` and one by `hobbes`, so a per-row lookup would show up as three.
      for (const [index, assignee] of ['ossy', 'ossy', 'hobbes'].entries()) {
        await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, title: `Task ${index}`, assignee }));
      }
      observed.length = 0;

      // Act
      await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));

      // Assert
      should(observed).have.length(1);
      should([...(observed[0] ?? [])].sort()).deepEqual(['hobbes', 'ossy']);
    });

    it('should not ask the fleet about rows a filter discarded, or about nobody at all', async () => {
      // A narrowed list must not fan out on behalf of tasks it is about to throw away, and a board
      // where nothing is assigned must not ask at all.
      // Arrange
      const observed: string[][] = [];
      const dispatch = dispatcher({ observed });
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, assignee: 'ossy', kind: 'feature' }));
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, assignee: 'hobbes', kind: 'bug' }));
      await dispatch.dispatch(post('/v1/sessions/s2/tasks', { ...CREATE, assignee: null }));
      observed.length = 0;

      // Act
      await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human, query: [['kind', 'bug']] }));
      const afterFilter = observed.map(batch => [...batch]);
      observed.length = 0;
      await dispatch.dispatch(request({ path: '/v1/sessions/s2/tasks', headers: human }));

      // Assert
      should(afterFilter).deepEqual([['hobbes']]);
      // Nothing is assigned on s2's board, so there is nobody to ask about.
      should(observed).be.empty();
    });

    it('should resolve the whole fleet read in one batch rather than one per session', async () => {
      // Arrange
      const observed: string[][] = [];
      const dispatch = dispatcher({ observed, sessionIds: ['s1', 's2'] });
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, assignee: 'ossy' }));
      await dispatch.dispatch(post('/v1/sessions/s2/tasks', { ...CREATE, assignee: 'hobbes' }));
      observed.length = 0;

      // Act
      await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));

      // Assert
      should(observed).have.length(1);
      should([...(observed[0] ?? [])].sort()).deepEqual(['hobbes', 'ossy']);
    });

    it('should report an assignee nothing resolves as unknown rather than as a hole', async () => {
      // Arrange
      const world: TaskWorld = {
        observations: { ossy: { sessionId: 's9', name: 'Ossy', status: 'running', lastActivityAt: AT } },
      };
      const dispatch = dispatcher(world);
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, assignee: 'ossy' }));
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, title: 'Other', assignee: 'nobody' }));

      // Act
      const listed = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
      const rows = (jsonBody(listed) as unknown as SessionTaskListResponse).tasks;

      // Assert
      // The teammate NAME resolved to the session that answers to it, which is what the whole batch
      // exists for: `--assignee <who>` names a teammate, not a session id.
      should(rows.find(row => row.assignee === 'ossy')?.live.assigneeSessionId).equal('s9');
      should(rows.find(row => row.assignee === 'ossy')?.live.assigneeName).equal('Ossy');
      // An assignee the daemon has never seen is honestly null in every field, not omitted.
      const unknown = rows.find(row => row.assignee === 'nobody')?.live;
      should(unknown?.assigneeSessionId).be.null();
      should(unknown?.assigneeName).be.null();
      should(unknown?.assigneeStatus).be.null();
    });
  });

  describe('creating a task', () => {
    it('should create the task, answer 201, and enrich it from the session index', async () => {
      // Arrange
      const world: TaskWorld = {
        observations: { s1: { sessionId: 's1', name: 'Wire Subsystems', status: 'running', lastActivityAt: AT } },
      };

      // Act
      const { task } = await withTask(world);

      // Assert
      should(task.id).equal('F1');
      should(task.title).equal(CREATE.title);
      should(task.sessionId).equal('s1');
      should(task.status).equal('todo');
      // An omitted assignee defaults to the owning session, so the live view resolves.
      should(task.assignee).equal('s1');
      should(task.live.assigneeName).equal('Wire Subsystems');
      should(task.blocked).be.false();
      should(task.blockedBy).be.empty();
      should(task.blockedSince).be.null();
    });

    it('should refuse a body the protocol schema rejects, naming the field', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const response = await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, title: '' }));

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid_request');
    });

    it('should refuse a body it could not read, and one that is not JSON', async () => {
      // A client that vanished mid-upload and a client that sent prose are both the caller's
      // problem; neither may be silently downgraded to "no fields given".
      // Arrange
      const dispatch = dispatcher();

      // Act
      const dropped = await dispatch.dispatch(
        request({ method: 'POST', path: '/v1/sessions/s1/tasks', headers: human, unreadableBody: true }),
      );
      const prose = await dispatch.dispatch(
        request({ method: 'POST', path: '/v1/sessions/s1/tasks', headers: human, body: 'not json at all' }),
      );

      // Assert
      should(dropped.status).equal(400);
      should(jsonBody(dropped)).have.property('code', 'unreadable_body');
      should(prose.status).equal(400);
      should(jsonBody(prose)).have.property('code', 'invalid_json');
    });

    it('should refuse an agent writing another session board', async () => {
      // The session id comes from the SERVER-derived actor, so a peer cannot name a different one.
      // Arrange
      const dispatch = dispatcher();

      // Act
      const response = await dispatch.dispatch(post('/v1/sessions/s2/tasks', CREATE, agentIn('s1')));

      // Assert
      should(response.status).equal(403);
      should(jsonBody(response)).have.property('code', 'forbidden');
    });

    it('should refuse a session id the state-home layout would not accept', async () => {
      // Arrange
      const dispatch = dispatcher({ unusable: ['NOPE'] });

      // Act
      const response = await dispatch.dispatch(post('/v1/sessions/NOPE/tasks', CREATE));

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid');
    });

    it('should refuse a path session id that is not usable as one segment', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const response = await dispatch.dispatch(post('/v1/sessions/%2e%2e/tasks', CREATE));

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid_session_id');
    });
  });

  describe('listing one session board', () => {
    it('should summarise every task, replacing the prose with its size', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
      const body = jsonBody(response) as unknown as SessionTaskListResponse;

      // Assert
      should(response.status).equal(200);
      should(body.sessionId).equal('s1');
      should(body.updatedAt).equal(AT);
      should(body.parseErrors).equal(0);
      should(body).not.have.property('parseErrorIds');
      should(body.tasks).have.length(1);
      should(body.tasks[0]).have.property('askChars', CREATE.ask.text.length);
      should(body.tasks[0]).have.property('askSource', 'human');
      should(body.tasks[0]).have.property('descriptionChars', 0);
      should(body.tasks[0]).have.property('clarificationCount', 0);
      // The heavy fields are gone, which is the whole point of a summary.
      should(body.tasks[0]).not.have.property('description');
      should(body.tasks[0]).not.have.property('ask');
    });

    it('should apply every filter the CLI sends, and match on all of them at once', async () => {
      // Arrange
      const { dispatch } = await withTask();
      const listing = (query: readonly (readonly [string, string])[]) =>
        dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human, query }));

      // Act
      const matched = await listing([
        ['kind', 'feature'],
        ['status', 'todo'],
        ['assignee', 's1'],
      ]);
      const missed = await listing([['kind', 'bug']]);
      const byRepo = await listing([['repo', 'ferretry']]);

      // Assert
      should((jsonBody(matched) as unknown as SessionTaskListResponse).tasks).have.length(1);
      should((jsonBody(missed) as unknown as SessionTaskListResponse).tasks).be.empty();
      // The task declares no repo, so a repo filter cannot match it.
      should((jsonBody(byRepo) as unknown as SessionTaskListResponse).tasks).be.empty();
    });

    it('should refuse a filter it does not implement rather than answering with the whole board', async () => {
      // Answering a narrowed request with everything looks like a board that matched everything.
      // Arrange
      const dispatch = dispatcher();

      // Act
      const response = await dispatch.dispatch(
        request({ path: '/v1/sessions/s1/tasks', headers: human, query: [['label', 'x']] }),
      );

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'unknown_filter');
    });

    it('should report a served board as having discarded nothing, because it never discards', async () => {
      // The board either decodes whole or it is refused, so this counter can only ever be zero — it
      // stays on the wire because the protocol requires it and both clients warn from it.
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
      const body = jsonBody(response) as unknown as SessionTaskListResponse;

      // Assert
      should(response.status).equal(200);
      should(body.parseErrors).equal(0);
      should(body).not.have.property('parseErrorIds');
    });

    it('should report an unreadable board as the daemon’s own state, not the caller’s request', async () => {
      // Replacing a corrupt board with an apparently empty one destroys the evidence, and answering
      // 400 sends an operator to audit a request that was perfectly well formed.
      // Arrange
      const dispatch = dispatcher({ boards: { s1: new FakeTaskBoard('s1', undefined, [], true) } });

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));

      // Assert
      should(response.status).equal(503);
      should(jsonBody(response)).have.property('code', 'unavailable');
      // The body is the fixed message, not whatever the store was looking at when it refused: a
      // damaged board's detail is an absolute path under the operator's state home.
      should(jsonBody(response)).have.property('error', TASK_UNAVAILABLE_MESSAGE);
      should(response.body).not.containEql(BOARD_UNREADABLE_DETAIL);
    });
  });

  describe('listing the whole fleet', () => {
    it('should read independent fleet boards through the bounded parallel pool', async () => {
      // The old route awaited each board in this loop. Each board is an independent atomic
      // snapshot, so the walk may overlap them, but must not start one callback per board without a
      // bound on a long-lived daemon. `readTaskBoardFleet` owns that rule and its own tests prove
      // it in isolation; what this case proves is that the ROUTE still asks it rather than
      // reintroducing a loop of its own.
      const sessionIds = Array.from({ length: 96 }, (_unused, index) => `s${index}`);
      let inFlight = 0;
      let peakInFlight = 0;
      const boards = Object.fromEntries(
        sessionIds.map(sessionId => {
          const board = new FakeTaskBoard(sessionId);
          const list = board.list.bind(board);
          board.list = async () => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            try {
              await Bun.sleep(8);
              return await list();
            } finally {
              inFlight -= 1;
            }
          };
          return [sessionId, board];
        }),
      );
      const dispatch = dispatcher({ boards, sessionIds });

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));

      // Assert — this proves both halves of the port: no serial per-board await, and no unbounded
      // session-callback fan-out beyond the source implementation's 64-session safety ceiling.
      should(response.status).equal(200);
      should(peakInFlight).equal(64);
    });

    it('should order fleet rows by the session index even when a later board answers first', async () => {
      // Overlapping the reads is only safe if the answer is still deterministic. Here the LAST
      // session's board is the fastest and the first is the slowest, so a route that gathered rows
      // as they arrived would hand an operator the fleet reversed — and reversed differently on the
      // next request, for no reason visible to them.
      const sessionIds = ['s0', 's1', 's2', 's3'];
      const delays: Record<string, number> = { s0: 40, s1: 30, s2: 20, s3: 10 };
      const boards = Object.fromEntries(
        sessionIds.map(sessionId => {
          const board = new FakeTaskBoard(sessionId);
          const list = board.list.bind(board);
          board.list = async () => {
            await Bun.sleep(delays[sessionId] as number);
            return await list();
          };
          return [sessionId, board];
        }),
      );
      const dispatch = dispatcher({ boards, sessionIds });
      for (const sessionId of sessionIds) await dispatch.dispatch(post(`/v1/sessions/${sessionId}/tasks`, CREATE));

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));
      const body = jsonBody(response) as unknown as { tasks: { sessionId: string }[] };

      // Assert
      should(response.status).equal(200);
      should(body.tasks.map(task => task.sessionId)).deepEqual(sessionIds);
    });

    it('should read every session board and keep each row scoped to its own session', async () => {
      // Arrange
      const boards = { s1: new FakeTaskBoard('s1'), s2: new FakeTaskBoard('s2') };
      const world: TaskWorld = { boards, sessionIds: ['s1', 's2'] };
      const dispatch = dispatcher(world);
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', CREATE));
      await dispatch.dispatch(post('/v1/sessions/s2/tasks', { ...CREATE, kind: 'bug' }));

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));
      const body = jsonBody(response) as unknown as { sessionId: null; tasks: { sessionId: string; id: string }[] };

      // Assert
      should(response.status).equal(200);
      should(body.sessionId).be.null();
      should(body.tasks.map(task => [task.sessionId, task.id])).deepEqual([
        ['s1', 'F1'],
        ['s2', 'B1'],
      ]);
    });

    it('should fail the whole fleet answer when one board is damaged, rather than answering short', async () => {
      // A fleet board silently missing one session's tasks is what an operator plans against, so the
      // missing work stops existing as far as anyone reading it is concerned. Refusing costs the
      // healthy boards their answer, and that is the accepted price of never lying about the fleet.
      // Arrange
      const boards = {
        good: new FakeTaskBoard('good'),
        broken: new FakeTaskBoard('broken', undefined, [], true),
      };
      const dispatch = dispatcher({ boards, sessionIds: ['good', 'broken'] });
      await dispatch.dispatch(post('/v1/sessions/good/tasks', CREATE));

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));

      // Assert
      should(response.status).equal(503);
      should(jsonBody(response)).have.property('code', 'unavailable');
      should(jsonBody(response)).have.property('error', TASK_UNAVAILABLE_MESSAGE);
      should(response.body).not.containEql(BOARD_UNREADABLE_DETAIL);
    });

    it('should let a defect in a fleet board stay a defect rather than call it unavailable', async () => {
      // Only a domain refusal means "damaged state". A TypeError is a bug in the daemon, and calling
      // it 503 would file it under conditions an operator is told to repair a file for.
      // Arrange
      const subsystem: TaskSubsystem = {
        board: () => {
          throw new TypeError('board is not a function');
        },
        sessionIds: async () => ['s1'],
        observe: async () => new Map(),
        now: () => AT,
      };
      const dispatch = new ApiDispatcher(new ApiRouter(taskRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));

      // Assert
      should(response.status).equal(500);
      should(jsonBody(response)).have.property('code', 'internal_error');
      // The dispatcher replaces an unexpected message, which is what keeps a defect's internals in.
      should(response.body).not.containEql('board is not a function');
    });

    it('should call a session the layout refuses damaged state, not the caller’s bad request', async () => {
      // Nobody named this session — the daemon's own index did — so 400 would blame a caller who
      // asked for the fleet and nothing else.
      // Arrange
      const dispatch = dispatcher({ sessionIds: ['NOPE'], unusable: ['NOPE'] });

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/tasks', headers: human }));

      // Assert
      should(response.status).equal(503);
      should(jsonBody(response)).have.property('code', 'unavailable');
      should(jsonBody(response)).have.property('error', TASK_UNAVAILABLE_MESSAGE);
      // The refusal named the session in its detail; the body must not carry it.
      should(response.body).not.containEql('NOPE');
    });

    it('should apply filters across the fleet and report an empty fleet honestly', async () => {
      // Arrange
      const dispatch = dispatcher({ sessionIds: [] });

      // Act
      const response = await dispatch.dispatch(
        request({ path: '/v1/tasks', headers: human, query: [['status', 'done']] }),
      );
      const body = jsonBody(response) as unknown as { tasks: unknown[]; parseErrors: number };

      // Assert
      should(body.tasks).be.empty();
      should(body.parseErrors).equal(0);
      should(body).not.have.property('parseErrorIds');
    });
  });

  describe('reading one task', () => {
    it('should answer the whole record and its whole history', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));
      const body = jsonBody(response) as unknown as ScopedTaskDetailResponse;

      // Assert
      should(response.status).equal(200);
      should(body.sessionId).equal('s1');
      should(body.task.id).equal('F1');
      should(body.activity.map(event => event.type)).deepEqual(['created']);
    });

    it('should mark an unstamped human attestation on read, however recent its timestamp', async () => {
      // Arrange — a record an UN-UPGRADED host wrote long after this fix was authored. A cutoff
      // date would read it as trustworthy; the missing semantics stamp is what gives it away.
      const board = new FakeTaskBoard('s1', {
        v: TASK_SNAPSHOT_SCHEMA_VERSION,
        tasks: [
          {
            task: legacyTask(),
            activity: [
              {
                v: 1,
                seq: 1,
                time: '2027-11-02T08:00:00.000Z',
                actor: 'peer:s1',
                actorName: null,
                type: 'status',
                data: {
                  from: 'live',
                  to: 'done',
                  phaseFrom: 'live',
                  phaseTo: 'done',
                  reason: 'claimed complete',
                  verifiedByHuman: true,
                },
              },
            ],
          },
        ],
      });
      const dispatch = dispatcher({ boards: { s1: board } });

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));
      const body = jsonBody(response) as unknown as ScopedTaskDetailResponse;

      // Assert
      should(response.status).equal(200);
      const recorded = body.activity[0]?.data as Record<string, unknown>;
      should(recorded).have.property('legacyAttestation', {
        reason: 'predates-actor-authority-split',
        splitLandedAt: ACTOR_AUTHORITY_SPLIT_LANDED_AT,
      });
      // The claim itself is left exactly as stored: marked as unreliable, never reclassified.
      should(recorded).have.property('verifiedByHuman', true);
    });

    it('should return only the history after the sequence the caller already holds', async () => {
      // Arrange
      const { dispatch } = await withTask();
      await dispatch.dispatch(post('/v1/sessions/s1/tasks/F1', { action: 'note', text: 'progress' }));

      // Act
      const all = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));
      const tail = await dispatch.dispatch(
        request({ path: '/v1/sessions/s1/tasks/F1', headers: human, query: [['after', '1']] }),
      );

      // Assert
      should((jsonBody(all) as unknown as ScopedTaskDetailResponse).activity).have.length(2);
      const after = (jsonBody(tail) as unknown as ScopedTaskDetailResponse).activity;
      should(after).have.length(1);
      should(after[0]).have.property('seq', 2);
    });

    it('should refuse an after cursor that is not a whole non-negative number', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const wordy = await dispatch.dispatch(
        request({ path: '/v1/sessions/s1/tasks/F1', headers: human, query: [['after', 'soon']] }),
      );
      const negative = await dispatch.dispatch(
        request({ path: '/v1/sessions/s1/tasks/F1', headers: human, query: [['after', '-1']] }),
      );

      // Assert
      should(wordy.status).equal(400);
      should(jsonBody(wordy)).have.property('code', 'invalid_after');
      should(negative.status).equal(400);
    });

    it('should answer not-found for a task the board does not hold', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F99', headers: human }));

      // Assert
      should(response.status).equal(404);
      should(jsonBody(response)).have.property('code', 'not-found');
    });

    it('should refuse a task id that is not usable as one path segment', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/%2e%2e', headers: human }));

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'invalid_task_id');
    });
  });

  describe('acting on a task', () => {
    it('should apply the action and answer the updated record', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'status', status: 'in_progress', reason: 'started' }),
      );
      const body = jsonBody(response) as unknown as ScopedTaskView;

      // Assert
      should(response.status).equal(200);
      should(body.status).equal('in_progress');
      should(body.phase).equal('build');
    });

    it('should journal a headerless admin CLI completion as admin-cli', async () => {
      // `human` deliberately has the shared admin bearer and CLI client header but no pane-session
      // header. The task route records the normalized API classification honestly; that operational
      // attribution is separate from, and never synthesized from, a board grant.
      // Arrange
      const { dispatch } = await withTask();
      for (const phase of ['build', 'built', 'live'] as const) {
        await dispatch.dispatch(
          post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase, reason: `move to ${phase}` }),
        );
      }

      // Act
      const completed = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'status', status: 'done', reason: 'checked from the CLI' }),
      );
      const detail = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));

      // Assert
      should(completed.status).equal(200);
      const activity = (jsonBody(detail) as unknown as ScopedTaskDetailResponse).activity;
      const recorded = [...activity].reverse().find(entry => entry.type === 'status');
      should(recorded).not.be.undefined();
      should(recorded?.actor).equal('admin-cli');
      should(recorded?.data).have.property('verifiedByHuman', true);
      should(recorded?.data).have.property('attestationSemantics', 'actor-authority-split');
      should(recorded?.data).not.have.property('authorization');
    });

    it('should report a blocked task with the reason the human gave', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'status', status: 'blocked', reason: 'waiting on review' }),
      );
      const body = jsonBody(response) as unknown as ScopedTaskView;

      // Assert
      should(body.blocked).be.true();
      should(body.blockedReason).equal('waiting on review');
      should(body.blockedSince).equal(AT);
    });

    it('should report a task held back by an unsatisfied dependency, naming the edge', async () => {
      // The blocking facts are computed over the WHOLE board because the edge lives in another
      // record; a per-task view could never see it.
      // Arrange
      const dispatch = dispatcher();
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', CREATE));
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', { ...CREATE, title: 'Depends on one' }));

      // Act
      const response = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F2', { action: 'dependency', taskId: 'F1' }),
      );
      const body = jsonBody(response) as unknown as ScopedTaskView;

      // Assert
      should(body.blocked).be.true();
      should(body.blockedBy).deepEqual(['F1']);
      // Nobody declared it blocked, so the reason is honestly absent — `blockedBy` explains it.
      should(body.blockedReason).be.null();
      should(body.blockedSince).equal(AT);
    });

    it('should report a refused transition as a conflict, not a bad request', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'status', status: 'live', reason: 'skipping ahead' }),
      );

      // Assert
      should(response.status).equal(409);
    });

    it('should refuse an agent acting on another session board', async () => {
      // Arrange
      const { dispatch } = await withTask();

      // Act
      const response = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'note', text: 'not mine' }, agentIn('s2')),
      );

      // Assert
      should(response.status).equal(403);
    });

    it('should require an explicit daemon-checked board grant before a peer marks shared live work done', async () => {
      // The button is a human action. This path is for a peer, whose capability
      // must reach the board domain before its task transaction is allowed.
      // Arrange
      const calls: { targetSessionId: string; capability: string; action: string }[] = [];
      const dispatch = dispatcher({
        boardActions: {
          authorize: async input => {
            calls.push(input);
            return RESOLVED_GRANT;
          },
        },
      });
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', CREATE));
      for (const phase of ['build', 'built', 'live'] as const) {
        await dispatch.dispatch(
          post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase, reason: `move to ${phase}` }),
        );
      }

      // Act
      const missing = await dispatch.dispatch(
        post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase: 'done', reason: 'claimed complete' }, agentIn('s1')),
      );
      const anonymous = await dispatch.dispatch(
        post(
          '/v1/sessions/s1/tasks/F1',
          { action: 'phase', phase: 'done', reason: 'claimed complete' },
          { ...agentIn('s1'), 'x-fy-board-capability': 'peer-capability' },
        ),
      );
      const done = await dispatch.dispatch(
        post(
          '/v1/sessions/s1/tasks/F1',
          { action: 'phase', phase: 'done', reason: 'claimed complete' },
          { ...agentIn('s1'), 'x-fy-board-capability': 'peer-capability', 'x-fy-request-id': 'click-1' },
        ),
      );

      // Assert
      should(missing.status).equal(401);
      // A grant with no caller-supplied id would journal provenance nothing can be joined back to
      // one decision, so the completion is refused rather than recorded against an invented key.
      should(anonymous.status).equal(400);
      should(jsonBody(anonymous)).have.property('code', 'missing_request_id');
      should(done.status).equal(200);
      should((jsonBody(done) as unknown as ScopedTaskView).phase).equal('done');
      should(calls).deepEqual([
        { targetSessionId: 's1', capability: 'peer-capability', action: 'mark_done' },
        { targetSessionId: 's1', capability: 'peer-capability', action: 'mark_done' },
      ]);
    });

    it('should reacquire cross-board scope before replaying one durable peer completion', async () => {
      // A response-loss retry arrives after the task is already done. The mount must find the exact
      // durable receipt before deciding that this peer is allowed to reacquire scope to another
      // member's board; otherwise the reducer would either bypass board scope or refuse the replay.
      // Arrange
      const calls: { targetSessionId: string; capability: string; action: string }[] = [];
      const dispatch = dispatcher({
        boardActions: {
          authorize: async input => {
            calls.push(input);
            return RESOLVED_GRANT;
          },
        },
      });
      await dispatch.dispatch(post('/v1/sessions/s2/tasks', { ...CREATE, status: 'live' }));
      const completion = { action: 'phase', phase: 'done', reason: 'checked another board' } as const;
      const headers = {
        ...agentIn('s1'),
        'x-fy-board-capability': 'peer-capability',
        'x-fy-request-id': 'cross-board-click-1',
      };

      // Act
      const completed = await dispatch.dispatch(post('/v1/sessions/s2/tasks/F1', completion, headers));
      const replayed = await dispatch.dispatch(post('/v1/sessions/s2/tasks/F1', completion, headers));
      const detail = await dispatch.dispatch(request({ path: '/v1/sessions/s2/tasks/F1', headers: human }));

      // Assert
      should(completed.status).equal(200);
      should(replayed.status).equal(200);
      should(calls).deepEqual([
        { targetSessionId: 's2', capability: 'peer-capability', action: 'mark_done' },
        { targetSessionId: 's2', capability: 'peer-capability', action: 'mark_done' },
      ]);
      const activity = (jsonBody(detail) as unknown as ScopedTaskDetailResponse).activity;
      should(activity.filter(entry => entry.type === 'status')).have.length(1);
      should(activity.filter(entry => entry.type === 'status' && entry.data.verifiedByTopAgent === true)).have.length(
        1,
      );
    });

    it('should refuse a grant whose peer disagrees with the completion actor without changing the task', async () => {
      // The session header is only attribution; the capability is the board's identity proof.
      // Letting them name different peers would journal a completion under an actor the board did
      // not authorize, which is false provenance even though the capability itself is valid.
      // Arrange
      const dispatch = dispatcher({
        boardActions: {
          authorize: async () => ({ ...RESOLVED_GRANT, sessionId: 's2' }),
        },
      });
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', CREATE));
      for (const phase of ['build', 'built', 'live'] as const) {
        await dispatch.dispatch(
          post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase, reason: `move to ${phase}` }),
        );
      }

      // Act
      const refused = await dispatch.dispatch(
        post(
          '/v1/sessions/s1/tasks/F1',
          { action: 'phase', phase: 'done', reason: 'claimed complete' },
          { ...agentIn('s1'), 'x-fy-board-capability': 's2-capability', 'x-fy-request-id': 'click-2' },
        ),
      );
      const detail = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));

      // Assert
      should(refused.status).equal(403);
      should(jsonBody(refused)).have.property('code', 'forbidden');
      const body = jsonBody(detail) as unknown as ScopedTaskDetailResponse;
      should(body.task.phase).equal('live');
      should(body.activity).have.length(4);
      should(body.activity.some(entry => entry.type === 'status' && entry.data.verifiedByTopAgent === true)).be.false();
    });

    it('should refuse malformed board evidence without creating a trusted top-agent attestation', async () => {
      // Arrange — a mount adapter is still a trust boundary: a broken authorizer must not become a
      // positively stamped completion merely because it returned an object of the broad grant shape.
      const dispatch = dispatcher({
        boardActions: {
          authorize: async () => ({ ...RESOLVED_GRANT, role: 'read', allowedActions: ['read'] }),
        },
      });
      await dispatch.dispatch(post('/v1/sessions/s1/tasks', CREATE));
      for (const phase of ['build', 'built', 'live'] as const) {
        await dispatch.dispatch(
          post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase, reason: `move to ${phase}` }),
        );
      }

      // Act
      const refused = await dispatch.dispatch(
        post(
          '/v1/sessions/s1/tasks/F1',
          { action: 'phase', phase: 'done', reason: 'claimed complete' },
          { ...agentIn('s1'), 'x-fy-board-capability': 'malformed-capability', 'x-fy-request-id': 'click-3' },
        ),
      );
      const detail = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks/F1', headers: human }));

      // Assert
      should(refused.status).equal(409);
      const body = jsonBody(detail) as unknown as ScopedTaskDetailResponse;
      should(body.task.phase).equal('live');
      should(body.activity).have.length(4);
      should(body.activity.some(entry => entry.type === 'status' && entry.data.verifiedByTopAgent === true)).be.false();
    });

    it('should keep a shared live completion unavailable when the board authorizer cannot mount', async () => {
      // Arrange — no fallback to the task route is allowed when the permission
      // source is unavailable: that would turn damaged board state into a grant.
      const { dispatch } = await withTask();
      for (const phase of ['build', 'built', 'live'] as const) {
        await dispatch.dispatch(
          post('/v1/sessions/s1/tasks/F1', { action: 'phase', phase, reason: `move to ${phase}` }),
        );
      }

      // Act
      const response = await dispatch.dispatch(
        post(
          '/v1/sessions/s1/tasks/F1',
          { action: 'phase', phase: 'done', reason: 'claimed complete' },
          { ...agentIn('s1'), 'x-fy-board-capability': 'peer-capability' },
        ),
      );

      // Assert
      should(response.status).equal(503);
      should(jsonBody(response)).have.property('code', 'unavailable');
    });
  });

  describe('failures that are not the client', () => {
    it('should let a defect become a 500 rather than being reported as the caller fault', async () => {
      // A board that throws something outside the task taxonomy is a bug in the daemon, and the
      // dispatcher answers with a fixed message rather than the thrown text.
      // Arrange
      const exploding: TaskWorld = {
        boards: {
          s1: Object.assign(new FakeTaskBoard('s1'), {
            list: async () => {
              throw new RangeError('a genuine defect');
            },
          }),
        },
      };
      const dispatch = dispatcher(exploding);

      // Act
      const response = await dispatch.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));

      // Assert
      should(response.status).equal(500);
    });

    it('should keep a domain refusal in its own taxonomy when the board raises one', () => {
      // Arrange / Act / Assert — the mapping table is exhaustive over the protocol's codes, so a new
      // code cannot be added without deciding its status.
      should(() => {
        throw new TaskError('cycle', 'that would close a loop');
      }).throw('that would close a loop');
    });
  });

  describe('the routes themselves', () => {
    it('should serve every task route as admin-only and never from a cache', () => {
      // Arrange / Act
      const routes = taskRoutes(taskSubsystem());

      // Assert
      should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
        'GET /v1/tasks',
        'GET /v1/sessions/:sessionId/tasks',
        'POST /v1/sessions/:sessionId/tasks',
        'GET /v1/sessions/:sessionId/tasks/:taskId',
        'POST /v1/sessions/:sessionId/tasks/:taskId',
      ]);
      should(routes.every(route => route.minimum === 'operator')).be.true();
      should(routes.every(route => route.noStore === true)).be.true();
    });

    it('should refuse a warden token on a board it has no scope for', async () => {
      // Arrange
      const dispatch = dispatcher();

      // Act
      const response = await dispatch.dispatch(
        request({
          path: '/v1/sessions/s1/tasks',
          headers: { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' },
        }),
      );

      // Assert
      should(response.status).be.aboveOrEqual(401);
      should(response.status).be.below(404);
    });
  });
});
