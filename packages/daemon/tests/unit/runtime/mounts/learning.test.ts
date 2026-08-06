import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { describe, it } from 'bun:test';
import {
  LearningConfigSchema,
  LearningPatchResponseSchema,
  LearningStatusSchema,
  ProposalViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import { learningRoutes } from '../../../../src/lib/runtime/mounts/learning.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  AT,
  CREDENTIALS,
  FakeLearningStore,
  human,
  LEARNING_CONFIG,
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
