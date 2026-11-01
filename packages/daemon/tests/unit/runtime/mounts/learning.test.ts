import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import {
  AgentLessonToolResultSchema,
  type GrantRefusal,
  LEARNING_APPLY_CONFLICT_CODE,
  LearningApplyPreviewSchema,
  LearningConfigSchema,
  LearningPatchResponseSchema,
  LearningScanEstimateSchema,
  LearningScanProgressSchema,
  LearningScanViewSchema,
  LearningStatusSchema,
  ProposalViewSchema,
  STEP_UP_REQUIRED_CODE,
  SessionLearningPatchResultSchema,
  SessionLearningSchema,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import type { LearningSubsystem } from '../../../../src/lib/runtime/mounts/learning.ts';
import { AGENT_SESSION_CAPABILITY_HEADER } from '../../../../src/lib/runtime/mounts/agent-tools.ts';
import { learningRoutes } from '../../../../src/lib/runtime/mounts/learning.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  AT,
  CREDENTIALS,
  FakeLearningStore,
  human,
  LEARNING_CONFIG,
  LESSON_CAPABILITY,
  LESSON_SESSION,
  lessonFacts,
  type LessonsWorld,
  lessonsWorld,
  learningSubsystem,
  observation,
  proposal,
} from './support.ts';

/**
 * The learning review mount, driven through the real router over the real policy.
 *
 * The store is in memory; every decision above it — which counters are reported, which proposals can
 * still be rendered, what a verdict does to the board, and what the tombstone records — is production
 * code. Each response is parsed with the protocol schema the CLI parses it with, so a shape the
 * shipped `fy learning` would refuse fails here instead.
 */

function dispatcher(store: FakeLearningStore): ApiDispatcher {
  return new ApiDispatcher(
    new ApiRouter(learningRoutes(learningSubsystem(store))),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
}

async function get(store: FakeLearningStore, path: string, query: readonly (readonly [string, string])[] = []) {
  return await dispatcher(store).dispatch(request({ path, headers: human, query }));
}

async function post(store: FakeLearningStore, path: string, body: unknown, on = dispatcher(store)) {
  return await on.dispatch(
    request({
      method: 'POST',
      path,
      headers: { ...human, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function ok(response: ApiResponse): Record<string, unknown> {
  should(response.status).equal(200);
  return jsonBody(response);
}

const OBSERVATION = observation({ id: 'obs_1' });
const PENDING = proposal({ id: 'proposal_a' });

describe('the learning review mount', () => {
  describe('status', () => {
    it('should report an empty home as nothing learned rather than as an error', async () => {
      // Arrange / Act
      const status = LearningStatusSchema.parse(ok(await get(new FakeLearningStore(), '/v1/learning/status')));

      // Assert
      should(status.pending).deepEqual({ total: 0, strong: 0, weak: 0 });
      should(status.totals).deepEqual({ observations: 0, proposals: 0, tombstones: 0 });
      should(status.running).be.false();
      // No miner is mounted, so the only honest answer is that mining is off.
      should(status.enabled).be.false();
      should(status.lastRun).be.undefined();
    });

    it('should split pending proposals by the strength their surviving evidence earns', async () => {
      // The split a human reads must be the pool's own rule applied to the evidence that still
      // exists — not the counter the file happened to claim.
      // Arrange
      const supporting = ['s1', 's2', 's3', 's4', 's5'].map(sessionId =>
        observation({ id: `obs_${sessionId}`, sessionId }),
      );
      const store = new FakeLearningStore(
        [
          proposal({ id: 'weak', observationIds: ['obs_s1'] }),
          proposal({ id: 'middling', observationIds: ['obs_s1', 'obs_s2', 'obs_s3'] }),
          proposal({ id: 'strong', observationIds: supporting.map(entry => entry.id) }),
          // A proposal that claims nine sessions but has one quote left is NOT strong.
          proposal({ id: 'overclaimed', occurrences: 9, observationIds: ['obs_s1'] }),
          proposal({ id: 'judged', state: 'accepted', observationIds: supporting.map(entry => entry.id) }),
        ],
        supporting,
        [{ identity: 'gone', titleHash: 'h', ruleGist: 'g', rejectedAt: AT }],
      );

      // Act
      const status = LearningStatusSchema.parse(ok(await get(store, '/v1/learning/status')));

      // Assert
      // Only five-or-more distinct sessions is `strong`; everything else pending is weak, and the two
      // must sum to the total or the protocol schema refuses the body.
      should(status.pending).deepEqual({ total: 4, strong: 1, weak: 3 });
      should(status.totals).deepEqual({ observations: 5, proposals: 5, tombstones: 1 });
    });

    it('should report the watermark and last run the state document carries', async () => {
      // Arrange
      const store = new FakeLearningStore([], [], [], {
        watermarkAt: '2026-07-30T09:00:00.000Z',
        lastRunAt: '2026-07-30T10:00:00.000Z',
        runningRunId: 'run-7',
      });

      // Act
      const status = LearningStatusSchema.parse(ok(await get(store, '/v1/learning/status')));

      // Assert
      should(status.watermarkAt).equal('2026-07-30T09:00:00.000Z');
      should(status.lastRunAt).equal('2026-07-30T10:00:00.000Z');
      // The daemon starts no run, so this can only be true because another writer left an id behind.
      should(status.running).be.true();
    });

    it('should drop instants a hand-edited state document made unusable', async () => {
      // The state file is decoded without validation, so junk in it must not become a response the
      // client cannot parse.
      // Arrange
      const store = new FakeLearningStore([], [], [], { watermarkAt: 'yesterday', lastRunAt: '' });

      // Act
      const status = LearningStatusSchema.parse(ok(await get(store, '/v1/learning/status')));

      // Assert
      should(status.watermarkAt).be.undefined();
      should(status.lastRunAt).be.undefined();
    });

    it('should report a valid run manifest and refuse a damaged one', async () => {
      // Arrange
      const manifest = {
        runId: 'run-3',
        startedAt: AT,
        sessionsScanned: 4,
        sessionsWithSignal: 2,
        minerSessions: ['m1'],
        observationsProposed: 3,
        observationsVerified: 2,
        rejectedQuotes: 1,
        malformedFiles: 0,
        proposalsCreated: 1,
        proposalsStrengthened: 0,
        proposalsSuppressedByTombstone: 0,
        perHarness: { claude: 2, codex: 0 },
      };
      const good = new FakeLearningStore([], [], [], {}, manifest);
      const damaged = new FakeLearningStore([], [], [], {}, { runId: 'run-4' });

      // Act
      const reported = LearningStatusSchema.parse(ok(await get(good, '/v1/learning/status')));
      const ignored = LearningStatusSchema.parse(ok(await get(damaged, '/v1/learning/status')));

      // Assert
      should(reported.lastRun?.runId).equal('run-3');
      // A manifest the schema rejects is a damaged file, not a run to report.
      should(ignored.lastRun).be.undefined();
    });
  });

  describe('config', () => {
    it('should report the schedule the daemon actually holds', async () => {
      // Arrange / Act
      const config = LearningConfigSchema.parse(ok(await get(new FakeLearningStore(), '/v1/learning/config')));

      // Assert
      should(config).deepEqual(LEARNING_CONFIG);
    });
  });

  describe('the proposal board', () => {
    it('should render a proposal with the evidence its observations carry', async () => {
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const listed = ok(await get(store, '/v1/learning/proposals'));
      const views = (listed as unknown as unknown[]).map(view => ProposalViewSchema.parse(view));

      // Assert
      should(views.map(view => view.id)).deepEqual(['proposal_a']);
      should(views[0]?.evidence.map(entry => [entry.observationId, entry.quote])).deepEqual([
        ['obs_1', 'use task test, not bun test'],
      ]);
    });

    it('should recompute counters from the evidence that still exists', async () => {
      // A proposal claiming five occurrences whose evidence was pruned would put a number on the
      // board that nothing supports.
      // Arrange
      const store = new FakeLearningStore(
        [proposal({ id: 'proposal_a', observationIds: ['obs_1', 'obs_2', 'gone'], occurrences: 9, crossRepoCount: 4 })],
        [
          observation({ id: 'obs_1', sessionId: 's1', repo: 'ferretry' }),
          observation({ id: 'obs_2', sessionId: 's2', repo: 'kteam' }),
        ],
      );

      // Act
      const views = (ok(await get(store, '/v1/learning/proposals')) as unknown as unknown[]).map(view =>
        ProposalViewSchema.parse(view),
      );

      // Assert
      should(views[0]?.occurrences).equal(2);
      should(views[0]?.crossRepoCount).equal(2);
      should(views[0]?.observationIds).deepEqual(['obs_1', 'obs_2']);
    });

    it('should omit a proposal whose evidence has been lost entirely', async () => {
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'orphan', observationIds: ['gone'] })], []);

      // Act
      const listed = ok(await get(store, '/v1/learning/proposals'));

      // Assert
      should(listed as unknown as unknown[]).be.empty();
    });

    it('should narrow the board to one lifecycle state', async () => {
      // Arrange
      const store = new FakeLearningStore(
        [proposal({ id: 'pending_a' }), proposal({ id: 'accepted_a', state: 'accepted' })],
        [OBSERVATION],
      );

      // Act
      const accepted = ok(await get(store, '/v1/learning/proposals', [['state', 'accepted']]));

      // Assert
      should((accepted as unknown as { id: string }[]).map(view => view.id)).deepEqual(['accepted_a']);
    });

    it('should refuse a state it does not know rather than answer with the whole board', async () => {
      // Answering a narrowed request with everything looks like a board that matched everything.
      // Arrange / Act
      const refused = await get(new FakeLearningStore(), '/v1/learning/proposals', [['state', 'maybe']]);
      const unknown = await get(new FakeLearningStore(), '/v1/learning/proposals', [['limit', '5']]);

      // Assert
      should(refused.status).equal(400);
      should(jsonBody(refused)).have.property('code', 'invalid_state');
      should(unknown.status).equal(400);
      should(jsonBody(unknown)).have.property('code', 'unknown_parameter');
    });
  });

  describe('a verdict', () => {
    it('should accept a proposal, record its history and file the patch it agreed to', async () => {
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const response = await post(store, '/v1/learning/proposals/proposal_a', { action: 'accept' });
      const view = ProposalViewSchema.parse(ok(response));

      // Assert
      should(view.state).equal('accepted');
      should(view.history.at(-1)).deepEqual({ at: AT, event: 'accepted', by: 'user' });
      // The board itself moved, not just the response.
      should(store.proposals.map(entry => entry.state)).deepEqual(['accepted']);
      // The only thing the daemon writes on the human's behalf, and it writes it inside its own home.
      should(store.patches.map(entry => entry.id)).deepEqual(['always-run-the-repo-task-surface']);
      should(store.patches[0]?.contents).containEql('Run `task test`');
    });

    it('should reject a proposal and tombstone it under both its identity and its title', async () => {
      // A reworded restatement of a rejected rule must not come back, so the title is hashed too.
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const view = ProposalViewSchema.parse(
        ok(await post(store, '/v1/learning/proposals/proposal_a', { action: 'reject', note: 'too broad' })),
      );

      // Assert
      should(view.state).equal('rejected');
      should(view.history.at(-1)).deepEqual({ at: AT, event: 'rejected', by: 'user', note: 'too broad' });
      should(store.tombstones).have.length(1);
      should(store.tombstones[0]?.identity).equal('always-run-the-repo-task-surface');
      should(store.tombstones[0]?.titleHash).not.be.empty();
      should(store.tombstones[0]?.note).equal('too broad');
      // Rejection files no patch: nothing was agreed to.
      should(store.patches).be.empty();
    });

    it('should reword a proposal without moving its lifecycle state', async () => {
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const view = ProposalViewSchema.parse(
        ok(await post(store, '/v1/learning/proposals/proposal_a', { action: 'edit', ruleText: 'Prefer `task test`.' })),
      );

      // Assert
      should(view.ruleText).equal('Prefer `task test`.');
      should(view.state).equal('pending');
      should(view.history.at(-1)?.event).equal('edited');
    });

    it('should refuse to re-judge a rejected proposal', async () => {
      // A verdict is final; resurrecting one the human already killed is the board refusing, not the
      // caller asking wrongly, so it is a conflict rather than a bad request.
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'proposal_a', state: 'rejected' })], [OBSERVATION]);

      // Act
      const refused = await post(store, '/v1/learning/proposals/proposal_a', { action: 'accept' });

      // Assert
      should(refused.status).equal(409);
      should(jsonBody(refused)).have.property('code', 'already-rejected');
    });

    it('should address a proposal by its stable identity as well as its id', async () => {
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const view = ProposalViewSchema.parse(
        ok(await post(store, '/v1/learning/proposals/always-run-the-repo-task-surface', { action: 'accept' })),
      );

      // Assert
      should(view.id).equal('proposal_a');
    });

    it('should answer 404 for a proposal the board does not hold', async () => {
      // Arrange / Act
      const missing = await post(new FakeLearningStore(), '/v1/learning/proposals/nope', { action: 'accept' });

      // Assert
      should(missing.status).equal(404);
      should(jsonBody(missing)).have.property('code', 'not-found');
    });

    it('should refuse a path parameter that is not a usable id', async () => {
      // Arrange / Act
      const refused = await post(new FakeLearningStore(), '/v1/learning/proposals/%2e%2e%2f', { action: 'accept' });

      // Assert
      should(refused.status).equal(400);
      should(jsonBody(refused)).have.property('code', 'invalid_proposal_id');
    });

    it('should refuse a body that names no known action', async () => {
      // Arrange / Act
      const refused = await post(new FakeLearningStore([PENDING]), '/v1/learning/proposals/proposal_a', {
        action: 'maybe',
      });

      // Assert
      should(refused.status).equal(400);
    });

    it('should say so when a landed verdict has no evidence left to render', async () => {
      // The verdict is durable either way; what cannot be produced is the RESPONSE, because the view
      // demands a surviving quote.
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'orphan', observationIds: ['gone'] })], []);

      // Act
      const response = await post(store, '/v1/learning/proposals/orphan', { action: 'accept' });

      // Assert
      should(response.status).equal(409);
      should(jsonBody(response)).have.property('code', 'evidence-missing');
      // The board still moved — the refusal is about rendering, not about the decision.
      should(store.proposals.map(entry => entry.state)).deepEqual(['accepted']);
    });

    it('should serialize two verdicts landing together so neither is lost', async () => {
      // The board is one snapshot rewritten whole; without a critical section the second write would
      // be computed from a board read before the first one landed.
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'a' }), proposal({ id: 'b' })], [OBSERVATION]);
      const on = dispatcher(store);

      // Act
      const [first, second] = await Promise.all([
        post(store, '/v1/learning/proposals/a', { action: 'accept' }, on),
        post(store, '/v1/learning/proposals/b', { action: 'reject' }, on),
      ]);

      // Assert
      should([first.status, second.status]).deepEqual([200, 200]);
      should(store.proposals.map(entry => [entry.id, entry.state])).deepEqual([
        ['a', 'accepted'],
        ['b', 'rejected'],
      ]);
    });
  });

  describe('the rendered patch', () => {
    it('should hand back the rule as a document aimed at the guidance file it names', async () => {
      // Arrange
      const store = new FakeLearningStore([PENDING], [OBSERVATION]);

      // Act
      const patch = LearningPatchResponseSchema.parse(ok(await get(store, '/v1/learning/proposals/proposal_a/patch')));

      // Assert
      should(patch.path).equal('guidance.md');
      should(patch.contents).containEql('# Always run the repo task surface');
      should(patch.contents).containEql('Apply under: ## Agent rules');
      should(patch.contents).containEql('Evidence: 1 session(s) across 1 repo(s)');
      // A read renders and writes nothing.
      should(store.patches).be.empty();
    });

    it('should omit the anchor line for a target that names none', async () => {
      // Arrange
      const store = new FakeLearningStore(
        [proposal({ id: 'proposal_a', target: { kind: 'automation-guidance', path: 'automation.md' } })],
        [OBSERVATION],
      );

      // Act
      const patch = LearningPatchResponseSchema.parse(ok(await get(store, '/v1/learning/proposals/proposal_a/patch')));

      // Assert
      should(patch.path).equal('automation.md');
      should(patch.contents).not.containEql('Apply under:');
    });

    it('should answer 404 for a patch on a proposal that does not exist', async () => {
      // Arrange / Act
      const missing = await get(new FakeLearningStore(), '/v1/learning/proposals/nope/patch');

      // Assert
      should(missing.status).equal(404);
    });
  });

  describe('mining', () => {
    it('should run the mounted miner through the subsystem', async () => {
      // Arrange / Act
      const run = await post(new FakeLearningStore(), '/v1/learning/run', { spawn: false });

      // Assert
      should(run.status).equal(200);
      should(jsonBody(run)).have.property('runId', 'run-1');
    });
  });
});

// ── Lessons: Apply, the per-ferret switch, the scan and passive filing ────────────────────────────

/**
 * Who is calling. Handlers for the lesson routes decide on governance, a fresh step-up and the caller's
 * kind, so each case drives the handler with a context it built rather than one a dispatcher derived.
 */
interface Caller {
  readonly kind: 'host' | 'device' | 'agent';
  /** `undefined` means the daemon could not say what this caller may do at all. */
  readonly governed?: boolean;
  /** What the grants answer for every demand; `granted` unless the case says otherwise. */
  readonly refusal?: GrantRefusal;
  readonly fresh?: boolean;
}

interface Call {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly query?: readonly (readonly [string, string])[];
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** How many times the handler spent the caller's fresh proof. */
  readonly spent: number;
}

const HOST: Caller = { kind: 'host', governed: false };
const DEVICE: Caller = { kind: 'device', governed: true };
const FRESH_DEVICE: Caller = { kind: 'device', governed: true, fresh: true };
const AGENT: Caller = { kind: 'agent', governed: false };

const CALLER_CREDENTIAL: Record<Caller['kind'], AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  agent: { kind: 'authenticated', tokenClass: 'admin' },
};
const CALLER_ACTOR: Record<Caller['kind'], string> = { host: 'admin-cli', device: 'device:d1', agent: 'peer:s1' };

/** Drive one lesson route as `caller`, an `ApiError` read back as the response the dispatcher would make. */
async function drive(subsystem: LearningSubsystem, input: Call, caller: Caller = HOST): Promise<Answer> {
  const found = new ApiRouter(learningRoutes(subsystem)).lookup(input.method, input.path);
  if (found.kind !== 'matched') throw new Error(`no route ${input.method} ${input.path}`);
  let spent = 0;
  const refusal = caller.refusal ?? 'granted';
  const governance: CallerGovernance | undefined =
    caller.governed === undefined
      ? undefined
      : { governed: caller.governed, decide: () => ({ allowed: refusal === 'granted', refusal }) };
  const context: RouteContext = {
    request: request({
      method: input.method,
      path: input.path,
      ...(input.query === undefined ? {} : { query: input.query }),
      headers: { 'content-type': 'application/json', ...input.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }),
    params: found.params,
    actor: CALLER_ACTOR[caller.kind],
    credential: CALLER_CREDENTIAL[caller.kind],
    ...(governance === undefined ? {} : { governance }),
    presentation: {
      loopback: caller.kind !== 'device',
      adminToken: caller.kind !== 'device',
      actor: CALLER_ACTOR[caller.kind],
      stepUp: caller.fresh === true,
      freshStepUp: caller.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  let response: ApiResponse;
  try {
    response = await found.route.handle(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, spent };
  }
  return { status: response.status, body: jsonBody(response), spent };
}

interface Lessons {
  readonly store: FakeLearningStore;
  readonly world: LessonsWorld;
  readonly subsystem: LearningSubsystem;
}

/** A learning subsystem whose lessons service is the REAL one over in-memory ports. */
function lessons(proposals: Parameters<typeof proposal>[0][] = [], observations = [OBSERVATION]): Lessons {
  const store = new FakeLearningStore(
    proposals.map(entry => proposal(entry)),
    observations,
  );
  const world = lessonsWorld(store);
  return { store, world, subsystem: learningSubsystem(store, world) };
}

const PROJECT = '/work/ferretry';
const GLOBAL_ACCEPTED = { id: 'global_a', state: 'accepted' } as const;
const REPO_ACCEPTED = {
  id: 'repo_a',
  identity: 'repo-lesson',
  state: 'accepted',
  category: 'repo',
  project: PROJECT,
  target: { kind: 'repo-instructions', path: PROJECT },
} as const;

const preview = (id: string): Call => ({ method: 'GET', path: `/v1/learning/proposals/${id}/apply-preview` });
const applyCall = (id: string, etag: unknown): Call => ({
  method: 'POST',
  path: `/v1/learning/proposals/${id}/apply`,
  body: etag === undefined ? {} : { etag },
});

/** The etag the preview hands out for `id`, as the owner would read it before applying. */
async function etagOf(subject: Lessons, id: string): Promise<string> {
  return LearningApplyPreviewSchema.parse((await drive(subject.subsystem, preview(id))).body).etag;
}

describe('the lessons mount', () => {
  describe('the machine default', () => {
    it('should write passiveDefault and answer the configuration now in effect', async () => {
      // Arrange
      const subject = lessons();

      // Act
      const answer = await drive(subject.subsystem, {
        method: 'PATCH',
        path: '/v1/learning/config',
        body: { passiveDefault: true },
      });

      // Assert
      should(answer.status).equal(200);
      should(LearningConfigSchema.parse(answer.body).passiveDefault).be.true();
      should(subject.world.config.passiveDefault).be.true();
    });

    it('should report the passive default on the status read', async () => {
      // Arrange / Act
      const status = LearningStatusSchema.parse(ok(await get(new FakeLearningStore(), '/v1/learning/status')));

      // Assert
      should(status.passiveDefault).equal(LEARNING_CONFIG.passiveDefault);
    });
  });

  describe('the apply preview', () => {
    it('should preview a global lesson into the fleet instructions', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, preview('global_a'));

      // Assert
      should(answer.status).equal(200);
      const parsed = LearningApplyPreviewSchema.parse(answer.body);
      should(parsed.capability).equal('fleet');
      should(parsed.path).equal(subject.world.global.path);
      should(parsed.exists).be.false();
      // A read writes nothing.
      should(subject.world.files.writes).be.empty();
    });

    it("should preview a repo lesson into the project's own instruction file", async () => {
      // Arrange
      const subject = lessons([REPO_ACCEPTED]);

      // Act
      const parsed = LearningApplyPreviewSchema.parse((await drive(subject.subsystem, preview('repo_a'))).body);

      // Assert
      should(parsed.capability).equal('filesystem');
      should(parsed.path.startsWith(`${PROJECT}/`)).be.true();
    });

    it('should restate each lessons refusal in the HTTP vocabulary', async () => {
      // Arrange
      const subject = lessons([
        { id: 'pending_a', identity: 'pending' },
        { id: 'homeless', identity: 'homeless', state: 'accepted', category: 'repo' },
      ]);

      // Act
      const missing = await drive(subject.subsystem, preview('nope'));
      const pending = await drive(subject.subsystem, preview('pending_a'));
      const homeless = await drive(subject.subsystem, preview('homeless'));

      // Assert
      should([missing.status, missing.body.code]).deepEqual([404, 'not-found']);
      should([pending.status, pending.body.code]).deepEqual([409, 'not_accepted']);
      // A repo lesson with no project has nowhere to be written.
      should([homeless.status, homeless.body.code]).deepEqual([400, 'invalid_request']);
    });

    it('should let a refusal that is not a lessons refusal through untouched', async () => {
      // A broken store is a fault, not a verdict, so it must not be dressed up as a 4xx.
      // Arrange
      class BrokenStore extends FakeLearningStore {
        override async loadProposals(): Promise<never> {
          throw new Error('EIO: the board is unreadable');
        }
      }
      const store = new BrokenStore();
      const subsystem = learningSubsystem(store, lessonsWorld(store));

      // Act / Assert
      await should(drive(subsystem, preview('any'))).be.rejectedWith('EIO: the board is unreadable');
    });
  });

  describe('apply', () => {
    it('should refuse an agent caller: applying is the owner act', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', 'absent'), AGENT);

      // Assert
      should([answer.status, answer.body.code]).deepEqual([403, 'forbidden']);
      should(subject.world.files.writes).be.empty();
    });

    it('should refuse when the daemon cannot say what this caller may do', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', 'absent'), { kind: 'host' });

      // Assert
      should([answer.status, answer.body.code]).deepEqual([403, 'forbidden']);
    });

    it('should ask for a passkey when the grants say a step-up is required', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', 'absent'), {
        ...DEVICE,
        refusal: 'step-up-required',
      });

      // Assert
      should(answer.status).equal(403);
      should(answer.body).have.property('code', STEP_UP_REQUIRED_CODE);
      should(answer.body.demand).deepEqual({ capability: 'fleet', axis: 'configure' });
      should(answer.body.error).containEql('the global instructions');
    });

    it('should name the grant refusal when the device may not write there', async () => {
      // Arrange
      const subject = lessons([REPO_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, applyCall('repo_a', 'absent'), {
        ...DEVICE,
        refusal: 'not-granted',
      });

      // Assert
      should([answer.status, answer.body.code]).deepEqual([403, 'grant_not_granted']);
      should(answer.body.error).containEql("a project's instruction file");
    });

    it('should demand a fresh step-up from a governed device writing into a project', async () => {
      // Arrange
      const subject = lessons([REPO_ACCEPTED]);
      const etag = await etagOf(subject, 'repo_a');

      // Act
      const answer = await drive(subject.subsystem, applyCall('repo_a', etag), DEVICE);

      // Assert
      should([answer.status, answer.body.code]).deepEqual([403, STEP_UP_REQUIRED_CODE]);
      should(answer.spent).equal(0);
      should(subject.world.files.writes).be.empty();
    });

    it('should write a repo lesson for a fresh step-up and spend it exactly once', async () => {
      // Arrange
      const subject = lessons([REPO_ACCEPTED]);
      const etag = await etagOf(subject, 'repo_a');

      // Act
      const answer = await drive(subject.subsystem, applyCall('repo_a', etag), FRESH_DEVICE);

      // Assert
      should(answer.status).equal(200);
      should(ProposalViewSchema.parse(answer.body).state).equal('applied');
      should(answer.spent).equal(1);
      should(subject.world.files.writes).have.length(1);
      should(subject.world.files.writes[0]?.path.startsWith(`${PROJECT}/`)).be.true();
    });

    it('should write a global lesson for a governed device without spending a step-up', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);
      const etag = await etagOf(subject, 'global_a');

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', etag), DEVICE);

      // Assert
      should(answer.status).equal(200);
      should(ProposalViewSchema.parse(answer.body).applied?.path).equal(subject.world.global.path);
      should(answer.spent).equal(0);
      should(subject.world.global.ensured).equal(1);
      should(subject.store.proposals.map(entry => entry.state)).deepEqual(['applied']);
    });

    it('should refuse a stale etag as an apply conflict', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);
      subject.world.files.texts.set(subject.world.global.path, '# Lessons\n');

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', 'absent'));

      // Assert
      should([answer.status, answer.body.code]).deepEqual([409, LEARNING_APPLY_CONFLICT_CODE]);
      should(subject.world.files.writes).be.empty();
    });

    it('should refuse a lesson that is missing or not accepted', async () => {
      // Arrange
      const subject = lessons([{ id: 'pending_a' }]);

      // Act
      const pending = await drive(subject.subsystem, applyCall('pending_a', 'absent'));
      const missing = await drive(subject.subsystem, applyCall('nope', 'absent'));

      // Assert
      should([pending.status, pending.body.code]).deepEqual([409, 'not_accepted']);
      should([missing.status, missing.body.code]).deepEqual([404, 'not-found']);
    });

    it('should say so when an applied lesson has no evidence left to render', async () => {
      // Arrange
      const subject = lessons([{ ...GLOBAL_ACCEPTED, observationIds: ['gone'] }], []);
      const etag = await etagOf(subject, 'global_a');

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', etag));

      // Assert
      should([answer.status, answer.body.code]).deepEqual([409, 'evidence-missing']);
      // The write landed; only the response could not be produced.
      should(subject.store.proposals.map(entry => entry.state)).deepEqual(['applied']);
    });

    it('should refuse a body with no etag', async () => {
      // Arrange
      const subject = lessons([GLOBAL_ACCEPTED]);

      // Act
      const answer = await drive(subject.subsystem, applyCall('global_a', undefined));

      // Assert
      should(answer.status).equal(400);
    });
  });

  describe('the per-ferret switch', () => {
    it('should list every ferret switch as recorded', async () => {
      // Arrange
      const subject = lessons();
      subject.store.sessionLearning = [{ sessionId: 's1', passive: true, since: AT, setBy: 'owner' }];

      // Act
      const answer = await drive(subject.subsystem, { method: 'GET', path: '/v1/learning/sessions' });

      // Assert
      should(answer.status).equal(200);
      const listed = (answer.body as unknown as unknown[]).map(entry => SessionLearningSchema.parse(entry));
      should(listed.map(entry => [entry.sessionId, entry.passive])).deepEqual([['s1', true]]);
    });

    it('should switch a running ferret and tell it with a queued message', async () => {
      // Arrange
      const subject = lessons();
      subject.world.sessions.sessions = [lessonFacts({ sessionId: LESSON_SESSION })];

      // Act
      const answer = await drive(subject.subsystem, {
        method: 'PATCH',
        path: `/v1/sessions/${LESSON_SESSION}/learning`,
        body: { passive: true },
      });

      // Assert
      should(answer.status).equal(200);
      const result = SessionLearningPatchResultSchema.parse(answer.body);
      should(result.reinstructed).be.true();
      should(result.learning.passive).be.true();
      should(subject.world.passive.sends.map(entry => entry.sessionId)).deepEqual([LESSON_SESSION]);
    });

    it('should refuse an unknown ferret and an unusable session id', async () => {
      // Arrange
      const subject = lessons();

      // Act
      const unknown = await drive(subject.subsystem, {
        method: 'PATCH',
        path: '/v1/sessions/nobody/learning',
        body: { passive: true },
      });
      const unusable = await drive(subject.subsystem, {
        method: 'PATCH',
        path: '/v1/sessions/%2e%2e%2f/learning',
        body: { passive: true },
      });

      // Assert
      should([unknown.status, unknown.body.code]).deepEqual([404, 'not-found']);
      should([unusable.status, unusable.body.code]).deepEqual([400, 'invalid_session_id']);
    });
  });

  describe('the explicit scan', () => {
    const SCOPE = { scope: { kind: 'not-passive' } };

    /** One ferret with a transcript that has something to mine, so a scan starts a real miner. */
    function minable(): Lessons {
      const subject = lessons();
      subject.world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      subject.world.miner.digests.set('s1', 4_000);
      return subject;
    }

    it('should estimate what a scan would read without starting one', async () => {
      // Arrange
      const subject = minable();

      // Act
      const answer = await drive(subject.subsystem, {
        method: 'POST',
        path: '/v1/learning/scan/estimate',
        body: SCOPE,
      });

      // Assert
      should(answer.status).equal(200);
      const estimate = LearningScanEstimateSchema.parse(answer.body);
      should(estimate.sessionIds).deepEqual(['s1']);
      should(subject.world.miner.starts).be.empty();
    });

    it('should start one scan at a time and report it', async () => {
      // Arrange
      const subject = minable();
      const scan: Call = { method: 'POST', path: '/v1/learning/scan', body: SCOPE };
      const view: Call = { method: 'GET', path: '/v1/learning/scan' };

      // Act
      const before = await drive(subject.subsystem, view);
      const started = await drive(subject.subsystem, scan);
      const again = await drive(subject.subsystem, scan);
      const after = await drive(subject.subsystem, view);

      // Assert
      should(LearningScanViewSchema.parse(before.body)).deepEqual({});
      should(started.status).equal(201);
      should(LearningScanProgressSchema.parse(started.body).state).equal('running');
      should([again.status, again.body.code]).deepEqual([409, 'scan_running']);
      should(LearningScanViewSchema.parse(after.body).scan?.state).equal('running');
    });

    it('should cancel a running scan and refuse to cancel one that never ran', async () => {
      // Arrange
      const subject = minable();
      const cancel: Call = { method: 'POST', path: '/v1/learning/scan/cancel' };
      const never = await drive(lessons().subsystem, cancel);
      await drive(subject.subsystem, { method: 'POST', path: '/v1/learning/scan', body: SCOPE });

      // Act
      const cancelled = await drive(subject.subsystem, cancel);

      // Assert
      should([never.status, never.body.code]).deepEqual([404, 'not-found']);
      should(cancelled.status).equal(200);
      should(LearningScanProgressSchema.parse(cancelled.body).state).equal('cancelled');
      should(subject.world.miner.stopped).deepEqual(['miner-0']);
    });
  });

  describe('a ferret filing a lesson', () => {
    const SUGGEST = { tool: 'lessons.suggest', rule: 'Run the repo task surface.', scope: 'global' };
    const file = (headers: Readonly<Record<string, string>> = {}): Call => ({
      method: 'POST',
      path: '/v1/agent/lessons',
      body: SUGGEST,
      headers,
    });

    it('should refuse a call that carries no session credential', async () => {
      // Arrange / Act
      const answer = await drive(lessons().subsystem, file(), AGENT);

      // Assert
      should([answer.status, answer.body.code]).deepEqual([401, 'missing_capability']);
    });

    it('should refuse a session credential the daemon did not mint', async () => {
      // Arrange / Act
      const answer = await drive(
        lessons().subsystem,
        file({ [AGENT_SESSION_CAPABILITY_HEADER]: 'fy_cap_forged' }),
        AGENT,
      );

      // Assert
      should([answer.status, answer.body.code]).deepEqual([403, 'forbidden']);
    });

    it("should file the lesson against the credential's own session", async () => {
      // Arrange
      const subject = lessons([], []);
      subject.world.sessions.sessions = [lessonFacts({ sessionId: LESSON_SESSION })];

      // Act
      const answer = await drive(
        subject.subsystem,
        file({ [AGENT_SESSION_CAPABILITY_HEADER]: LESSON_CAPABILITY }),
        AGENT,
      );

      // Assert
      should(answer.status).equal(200);
      should(AgentLessonToolResultSchema.parse(answer.body).outcome).equal('filed');
      should(subject.store.observations.map(entry => entry.sessionId)).deepEqual([LESSON_SESSION]);
    });

    it('should take the credential as an Authorization bearer too, as the agent tools do', async () => {
      // Arrange — a credential in the shape every launch now mints, resolving to the same session.
      const bearer = `fys_${'l'.repeat(43)}`;
      const subject = lessons([], []);
      subject.world.sessions.sessions = [lessonFacts({ sessionId: LESSON_SESSION })];
      const subsystem = {
        ...subject.subsystem,
        identities: {
          resolve: async (capability: string) => (capability === bearer ? { sessionId: LESSON_SESSION } : undefined),
        },
      };

      // Act
      const filed = await drive(subsystem, file({ authorization: `Bearer ${bearer}` }), AGENT);
      const two = await drive(
        subsystem,
        file({ authorization: `Bearer ${bearer}`, [AGENT_SESSION_CAPABILITY_HEADER]: LESSON_CAPABILITY }),
        AGENT,
      );

      // Assert
      should(filed.status).equal(200);
      should(subject.store.observations.map(entry => entry.sessionId)).deepEqual([LESSON_SESSION]);
      should([two.status, two.body.code]).deepEqual([401, 'unauthorized']);
    });

    it('should answer 404 when the credential names a session the daemon no longer holds', async () => {
      // Arrange / Act
      const answer = await drive(
        lessons().subsystem,
        file({ [AGENT_SESSION_CAPABILITY_HEADER]: LESSON_CAPABILITY }),
        AGENT,
      );

      // Assert
      should([answer.status, answer.body.code]).deepEqual([404, 'not-found']);
    });
  });

  describe('the extended verdicts', () => {
    it('should move a lesson to its project and refuse one that came from no single project', async () => {
      // Arrange
      const store = new FakeLearningStore(
        [
          proposal({ id: 'rooted', identity: 'rooted', project: PROJECT }),
          proposal({ id: 'homeless', identity: 'homeless' }),
        ],
        [OBSERVATION],
      );

      // Act
      const moved = await post(store, '/v1/learning/proposals/rooted', { action: 'categorize', category: 'repo' });
      const refused = await post(store, '/v1/learning/proposals/homeless', { action: 'categorize', category: 'repo' });

      // Assert
      const view = ProposalViewSchema.parse(ok(moved));
      should(view.category).equal('repo');
      should(view.target).deepEqual({ kind: 'repo-instructions', path: PROJECT });
      should(view.history.at(-1)?.event).equal('categorized:repo');
      should(refused.status).equal(400);
      should(jsonBody(refused)).have.property('code', 'invalid_request');
    });

    it('should reopen an accepted lesson back to pending', async () => {
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'proposal_a', state: 'accepted' })], [OBSERVATION]);

      // Act
      const view = ProposalViewSchema.parse(
        ok(await post(store, '/v1/learning/proposals/proposal_a', { action: 'reopen' })),
      );

      // Assert
      should(view.state).equal('pending');
      should(view.history.at(-1)?.event).equal('reopened');
    });

    it('should refuse any verdict on a lesson that is already in its file', async () => {
      // Arrange
      const store = new FakeLearningStore([proposal({ id: 'proposal_a', state: 'applied' })], [OBSERVATION]);

      // Act
      const refused = await post(store, '/v1/learning/proposals/proposal_a', {
        action: 'categorize',
        category: 'global',
      });

      // Assert
      should(refused.status).equal(409);
      should(jsonBody(refused)).have.property('code', 'already-applied');
    });

    it('should narrow the board to applied lessons and render the turn an observation carries', async () => {
      // Arrange
      const store = new FakeLearningStore(
        [proposal({ id: 'pending_a' }), proposal({ id: 'applied_a', state: 'applied' })],
        [observation({ id: 'obs_1', turn: 7 })],
      );

      // Act
      const views = (
        ok(await get(store, '/v1/learning/proposals', [['state', 'applied']])) as unknown as unknown[]
      ).map(view => ProposalViewSchema.parse(view));

      // Assert
      should(views.map(view => view.id)).deepEqual(['applied_a']);
      should(views[0]?.evidence[0]?.turn).equal(7);
    });
  });
});
