import { describe, it } from 'bun:test';
import { LESSONS_INSTRUCTION } from '@ferretry/fleet';
import { LEARNING_ABSENT_FILE_ETAG } from '@ferretry/protocol';
import should from 'should';
import {
  GLOBAL_LESSONS_FILE,
  insertLesson,
  lessonFileEtag,
  LessonsError,
  reinstructionMessage,
  slugify,
  unifiedDiff,
  type ScanRecord,
} from '../../../src/lib/learning/index.ts';
import { AT, LEARNING_CONFIG, LESSON_MINER_LABEL, lessonFacts, lessonsWorld, observation, proposal } from '../runtime/mounts/support.ts';

/**
 * `LessonsService` over the in-memory ports: the passive switch, a ferret's own `suggest`, Apply, the
 * category change, and the explicit scan — every decision the daemon's lessons route restates in HTTP.
 */

function scanRecord(overrides: Partial<ScanRecord> = {}): ScanRecord {
  return {
    runId: 'scan-seed',
    state: 'running',
    sessionIds: [],
    batches: [],
    startedAt: AT,
    done: 0,
    added: 0,
    merged: 0,
    ...overrides,
  };
}

describe('reinstructionMessage', () => {
  it('should carry the fleet teaching in the ON message and name the suggest command in the OFF message', () => {
    // Act
    const on = reinstructionMessage(true, 'fy');
    const off = reinstructionMessage(false, 'fy');

    // Assert
    should(on).containEql(LESSONS_INSTRUCTION('fy'));
    should(off).containEql('fy lesson suggest');
  });
});

describe('LessonsService', () => {
  // ── sessionLearning ──────────────────────────────────────────────────────────────────────────

  describe('sessionLearning', () => {
    it('should list every recorded switch', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.sessionLearning = [
        { sessionId: 's1', passive: true, since: AT, setBy: 'default' },
        { sessionId: 's2', passive: false, since: AT, setBy: 'owner' },
      ];

      // Act
      const records = await world.service.sessionLearning();

      // Assert
      should(records).deepEqual(world.store.sessionLearning);
    });
  });

  // ── adopt ────────────────────────────────────────────────────────────────────────────────────

  describe('adopt', () => {
    it('should take the machine default when it is true', async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, passiveDefault: true };

      // Act
      const record = await world.service.adopt('s1');

      // Assert
      should(record).deepEqual({ sessionId: 's1', passive: true, since: AT, setBy: 'default' });
      should(world.store.sessionLearning).deepEqual([record]);
      should(world.passive.environment).deepEqual([{ sessionId: 's1', passive: true }]);
    });

    it('should take the machine default when it is false', async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, passiveDefault: false };

      // Act
      const record = await world.service.adopt('s2');

      // Assert
      should(record.passive).be.false();
      should(record.setBy).equal('default');
    });

    it('should replace an existing record for the same session rather than adding a second one', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.sessionLearning = [
        { sessionId: 's1', passive: true, since: '2000-01-01T00:00:00.000Z', setBy: 'owner' },
      ];
      world.config = { ...LEARNING_CONFIG, passiveDefault: false };

      // Act
      await world.service.adopt('s1');

      // Assert
      should(world.store.sessionLearning).deepEqual([{ sessionId: 's1', passive: false, since: AT, setBy: 'default' }]);
    });
  });

  // ── setPassive ───────────────────────────────────────────────────────────────────────────────

  describe('setPassive', () => {
    it('should refuse an unknown session', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act / Assert
      await should(world.service.setPassive('ghost', true)).be.rejectedWith({ reason: 'not-found' });
    });

    it.each([
      { previous: undefined, passive: false, label: 'off' },
      { previous: true, passive: true, label: 'on' },
    ])('should report nothing changed when the switch was already $label', async ({ previous, passive }) => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1', running: true })];
      if (previous !== undefined) {
        world.store.sessionLearning = [{ sessionId: 's1', passive: previous, since: AT, setBy: 'owner' }];
      }

      // Act
      const result = await world.service.setPassive('s1', passive);

      // Assert
      should(result.reinstructed).be.false();
      should(result.sendId).be.undefined();
      should(result.note).containEql('already');
      should(world.passive.sends).have.length(0);
    });

    it('should note the next launch and send nothing when the ferret is not running', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1', running: false })];
      world.store.sessionLearning = [{ sessionId: 's1', passive: false, since: AT, setBy: 'owner' }];

      // Act
      const result = await world.service.setPassive('s1', true);

      // Assert
      should(result.reinstructed).be.false();
      should(result.sendId).be.undefined();
      should(result.note).containEql('next launch');
      should(world.passive.sends).have.length(0);
      should(world.passive.environment).deepEqual([{ sessionId: 's1', passive: true }]);
    });

    it('should re-instruct a running ferret that changed and answer the send id', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1', running: true })];
      world.store.sessionLearning = [{ sessionId: 's1', passive: false, since: AT, setBy: 'owner' }];

      // Act
      const result = await world.service.setPassive('s1', true);

      // Assert
      should(result.reinstructed).be.true();
      should(result.sendId).equal('send-1');
      should(world.passive.sends).deepEqual([{ sessionId: 's1', message: reinstructionMessage(true, 'fy') }]);
      should(world.passive.environment).deepEqual([{ sessionId: 's1', passive: true }]);
    });

    it('should re-instruct the OFF message naming the suggest command', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1', running: true })];
      world.store.sessionLearning = [{ sessionId: 's1', passive: true, since: AT, setBy: 'owner' }];

      // Act
      const result = await world.service.setPassive('s1', false);

      // Assert
      should(result.reinstructed).be.true();
      should(world.passive.sends[0]?.message).equal(reinstructionMessage(false, 'fy'));
      should(world.passive.sends[0]?.message).containEql('fy lesson suggest');
    });
  });

  // ── suggest ──────────────────────────────────────────────────────────────────────────────────

  describe('suggest', () => {
    it('should refuse an unknown session', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act / Assert
      await should(world.service.suggest('ghost', 'rule text', 'global')).be.rejectedWith({ reason: 'not-found' });
    });

    it("should attribute the owner's latest message as human evidence, with its own turn and time", async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.sessions.owner.set('s1', { text: 'Run task test, not bun test directly.', at: '2024-05-01T09:00:00.000Z', turn: 3 });

      // Act
      await world.service.suggest('s1', 'Run task test rather than the test runner directly.', 'global');

      // Assert
      const stored = world.store.observations[0];
      should(stored?.source).equal('human');
      should(stored?.quote).equal('Run task test, not bun test directly.');
      should(stored?.turn).equal(3);
      should(stored?.at).equal('2024-05-01T09:00:00.000Z');
    });

    it('should attribute a quiet session to the ferret itself, quoting the rule, at the call time', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];

      // Act
      await world.service.suggest('s1', 'Run task test rather than the test runner directly.', 'global');

      // Assert
      const stored = world.store.observations[0];
      should(stored?.source).equal('teammate');
      should(stored?.quote).equal('Run task test rather than the test runner directly.');
      should(stored?.turn).be.undefined();
      should(stored?.at).equal(AT);
    });

    it('should take the project from the files port, not the raw cwd', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1', cwd: '/work/ferretry/packages/cli' })];
      world.files.roots.set('/work/ferretry/packages/cli', '/work/ferretry');

      // Act
      await world.service.suggest('s1', 'Run task test rather than the test runner directly.', 'global');

      // Assert
      should(world.store.proposals[0]?.project).equal('/work/ferretry');
    });

    it('should summarize a filed Global lesson as Global', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];

      // Act
      const result = await world.service.suggest('s1', 'Run task test rather than the test runner directly.', 'global');

      // Assert
      should(result.outcome).equal('filed');
      should(result.summary).equal('Filed a new Global lesson for the owner to review.');
    });

    it('should summarize a filed Repo lesson as Repo', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];

      // Act
      const result = await world.service.suggest('s1', 'Run task test rather than the test runner directly.', 'repo');

      // Assert
      should(result.outcome).equal('filed');
      should(result.summary).equal('Filed a new Repo lesson for the owner to review.');
    });

    it('should merge a second filing of the same open rule and report the new count', async () => {
      // Arrange
      const rule = 'Run task test rather than the test runner directly.';
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's2' })];
      world.store.proposals = [
        proposal({ id: 'lesson_seed', category: 'global', state: 'pending', ruleText: rule, observationIds: ['obs_seed'], count: 1 }),
      ];

      // Act
      const result = await world.service.suggest('s2', rule, 'global');

      // Assert
      should(result.outcome).equal('merged');
      should(result.count).equal(2);
      should(result.summary).containEql('2×');
      should(world.store.proposals).have.length(1);
      should(world.store.observations).have.length(1);
    });

    it('should not file a rule a tombstone already covers, and write nothing', async () => {
      // Arrange
      const rule = 'Run task test rather than the test runner directly.';
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.store.tombstones = [{ identity: slugify(rule), titleHash: 'deadbeef', ruleGist: rule, rejectedAt: AT }];

      // Act
      const result = await world.service.suggest('s1', rule, 'global');

      // Assert
      should(result.outcome).equal('previously-rejected');
      should(result.summary).containEql('already rejected');
      should(world.store.proposals).have.length(0);
      should(world.store.observations).have.length(0);
    });

    it('should not re-file a rule the owner already rejected as a proposal, and write nothing', async () => {
      // Arrange
      const rule = 'Run task test rather than the test runner directly.';
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.store.proposals = [proposal({ id: 'lesson_rejected', state: 'rejected', ruleText: rule })];

      // Act
      const result = await world.service.suggest('s1', rule, 'global');

      // Assert
      should(result.outcome).equal('previously-rejected');
      should(world.store.proposals).deepEqual([proposal({ id: 'lesson_rejected', state: 'rejected', ruleText: rule })]);
      should(world.store.observations).have.length(0);
    });
  });

  // ── Apply: target resolution ─────────────────────────────────────────────────────────────────

  describe('applyPreview / apply / applyCapability / categorize', () => {
    it('should refuse a lesson id that matches neither an id nor an identity', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', identity: 'p1-identity', state: 'accepted' })];

      // Act / Assert
      await should(world.service.applyPreview('nope')).be.rejectedWith({ reason: 'not-found' });
    });

    it('should resolve a lesson looked up by its identity, not only by its id', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', identity: 'p1-identity', category: 'global', state: 'accepted' })];

      // Act
      const capability = await world.service.applyCapability('p1-identity');

      // Assert
      should(capability).equal('fleet');
    });

    it('should refuse a lesson that is not accepted yet', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', state: 'pending' })];

      // Act / Assert
      await should(world.service.applyPreview('p1')).be.rejectedWith({ reason: 'not-accepted' });
    });

    it("should target the global document at the global port's own path and notes, with the fleet capability", async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'global', state: 'accepted' })];

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/fleet/assets/instructions/lessons.md');
      should(preview.notes).deepEqual(['No profile includes instructions/lessons yet.']);
      should(preview.capability).equal('fleet');
    });

    it('should refuse a repo lesson with no project to write to', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: undefined })];

      // Act / Assert
      await should(world.service.applyPreview('p1')).be.rejectedWith({ reason: 'invalid' });
    });

    it('should write to AGENTS.md when it is present, even alongside a CLAUDE.md', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj' })];
      world.files.texts.set('/proj/AGENTS.md', '# agents\n');
      world.files.texts.set('/proj/CLAUDE.md', '# claude\n');

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/AGENTS.md');
      should(preview.capability).equal('filesystem');
    });

    it('should write to CLAUDE.md when AGENTS.md is absent but CLAUDE.md is present', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj' })];
      world.files.texts.set('/proj/CLAUDE.md', '# claude\n');

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/CLAUDE.md');
    });

    it("should fall back to the filing session's own harness when neither file exists: codex writes AGENTS.md", async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj', observationIds: ['obs1'] })];
      world.store.observations = [observation({ id: 'obs1', sessionId: 'codex-sess' })];
      world.sessions.sessions = [lessonFacts({ sessionId: 'codex-sess', harness: 'codex' })];

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/AGENTS.md');
    });

    it("should fall back to the filing session's own harness when neither file exists: claude writes CLAUDE.md", async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj', observationIds: ['obs1'] })];
      world.store.observations = [observation({ id: 'obs1', sessionId: 'claude-sess' })];
      world.sessions.sessions = [lessonFacts({ sessionId: 'claude-sess', harness: 'claude' })];

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/CLAUDE.md');
    });

    it('should fall back to claude when the filing observation is unknown', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj', observationIds: ['missing-obs'] })];

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/CLAUDE.md');
    });

    it('should fall back to claude when the filing session itself is unknown', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj', observationIds: ['obs1'] })];
      world.store.observations = [observation({ id: 'obs1', sessionId: 'ghost-sess' })];

      // Act
      const preview = await world.service.applyPreview('p1');

      // Assert
      should(preview.path).equal('/proj/CLAUDE.md');
    });

    it('should report exists/etag/diff for an absent file and for one that exists', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [
        proposal({ id: 'absent', category: 'repo', state: 'accepted', project: '/proj' }),
        proposal({ id: 'present', category: 'repo', state: 'accepted', project: '/other', ruleText: 'Use direnv exec.' }),
      ];
      world.files.texts.set('/other/CLAUDE.md', '# notes\n');

      // Act
      const absentPreview = await world.service.applyPreview('absent');
      const presentPreview = await world.service.applyPreview('present');

      // Assert
      should(absentPreview.exists).be.false();
      should(absentPreview.etag).equal(LEARNING_ABSENT_FILE_ETAG);
      should(absentPreview.diff).equal(unifiedDiff('/proj/CLAUDE.md', undefined, insertLesson(undefined, proposal({ id: 'absent' }).ruleText)));

      should(presentPreview.exists).be.true();
      should(presentPreview.etag).equal(lessonFileEtag('# notes\n'));
      should(presentPreview.diff).equal(unifiedDiff('/other/CLAUDE.md', '# notes\n', insertLesson('# notes\n', 'Use direnv exec.')));
    });

    it('should answer the capability a repo apply needs as filesystem', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj' })];

      // Act
      const capability = await world.service.applyCapability('p1');

      // Assert
      should(capability).equal('filesystem');
    });

    it('should refuse to apply with a stale etag and write nothing', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj' })];
      world.files.texts.set('/proj/CLAUDE.md', '# notes\n');

      // Act / Assert
      await should(world.service.apply('p1', 'stale-etag')).be.rejectedWith({ reason: 'conflict' });
      should(world.files.writes).have.length(0);
    });

    it('should write the lesson, mark it applied with its history, and leave other proposals untouched', async () => {
      // Arrange
      const world = lessonsWorld();
      const other = proposal({ id: 'other', state: 'pending' });
      world.store.proposals = [proposal({ id: 'p1', category: 'global', state: 'accepted', ruleText: 'Use direnv exec.' }), other];
      const preview = await world.service.applyPreview('p1');

      // Act
      const applied = await world.service.apply('p1', preview.etag);

      // Assert
      should(world.files.writes).deepEqual([
        { path: '/fleet/assets/instructions/lessons.md', text: insertLesson(undefined, 'Use direnv exec.') },
      ]);
      should(world.global.ensured).equal(1);
      should(applied.state).equal('applied');
      should(applied.applied).deepEqual({ at: AT, path: '/fleet/assets/instructions/lessons.md' });
      should(applied.history.at(-1)).deepEqual({ at: AT, event: 'applied', by: 'user', note: '/fleet/assets/instructions/lessons.md' });
      should(world.store.proposals).containEql(other);
      should(world.store.proposals.find(entry => entry.id === 'p1')).deepEqual(applied);
    });

    it('should not touch the global component when applying a repo lesson', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.proposals = [proposal({ id: 'p1', category: 'repo', state: 'accepted', project: '/proj' })];
      const preview = await world.service.applyPreview('p1');

      // Act
      await world.service.apply('p1', preview.etag);

      // Assert
      should(world.global.ensured).equal(0);
    });

    it('should refuse to re-categorize an already applied lesson', () => {
      // Arrange
      const world = lessonsWorld();
      const applied = proposal({ id: 'p1', state: 'applied' });

      // Act / Assert
      should(() => world.service.categorize(applied, 'global')).throw(LessonsError, { reason: 'conflict' });
    });

    it('should refuse to categorize a lesson with no project as repo', () => {
      // Arrange
      const world = lessonsWorld();
      const noProject = proposal({ id: 'p1', state: 'pending', project: undefined });

      // Act / Assert
      should(() => world.service.categorize(noProject, 'repo')).throw(LessonsError, { reason: 'invalid' });
    });

    it('should move a lesson to repo with a repo-instructions target naming its project', () => {
      // Arrange
      const world = lessonsWorld();
      const pending = proposal({ id: 'p1', state: 'pending', category: 'global', project: '/proj' });

      // Act
      const recategorized = world.service.categorize(pending, 'repo');

      // Assert
      should(recategorized.category).equal('repo');
      should(recategorized.target).deepEqual({ kind: 'repo-instructions', path: '/proj' });
    });

    it('should move a lesson to global with the shared global-instructions target', () => {
      // Arrange
      const world = lessonsWorld();
      const pending = proposal({ id: 'p1', state: 'pending', category: 'repo', project: '/proj' });

      // Act
      const recategorized = world.service.categorize(pending, 'global');

      // Assert
      should(recategorized.category).equal('global');
      should(recategorized.target).deepEqual({ kind: 'global-instructions', path: GLOBAL_LESSONS_FILE });
    });
  });

  // ── estimate ─────────────────────────────────────────────────────────────────────────────────

  describe('estimate', () => {
    it('should pass an explicit session scope through to the selection', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', createdAt: '2024-05-01T09:00:00.000Z' }),
        lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:30:00.000Z' }),
      ];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'sessions', sessionIds: ['s1'] } });

      // Assert
      should(result.sessionIds).deepEqual(['s1']);
      should(result.sessions).equal(1);
    });

    it('should price a model the daemon knows', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.miner.digests.set('s1', 400);

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' }, model: 'opus' });

      // Assert
      should(result.tokens).equal(3600);
      should(result.miners).equal(1);
      should(result.usd).equal(0.036);
      should(result.model).equal('opus');
    });

    it('should leave usd absent for a model the daemon does not price', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.miner.digests.set('s1', 400);

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' }, model: 'unpriced-model' });

      // Assert
      should(result).not.have.property('usd');
      should(result.model).equal('unpriced-model');
    });

    it('should report usd as exactly zero when nothing has a digest to mine', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' }, model: 'opus' });

      // Assert
      should(result.miners).equal(0);
      should(result.usd).equal(0);
    });

    it('should report neither usd nor model when none is configured or requested', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.miner.digests.set('s1', 400);

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' } });

      // Assert
      should(result).not.have.property('usd');
      should(result).not.have.property('model');
    });

    it("should let the request's own agent and model override the machine config", async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, agent: 'claude' };
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];
      world.miner.digests.set('s1', 400);

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' }, agent: 'codex', model: 'opus' });

      // Assert
      should(result.agent).equal('codex');
      should(result.model).equal('opus');
    });

    it('should cap at maxSessionsPerRun and report the rest as beyondLimit', async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, maxSessionsPerRun: 1 };
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', createdAt: '2024-05-01T09:00:00.000Z' }),
        lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:30:00.000Z' }),
      ];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' } });

      // Assert
      should(result.sessionIds).deepEqual(['s1']);
      should(result.sessions).equal(1);
      should(result.beyondLimit).equal(1);
    });

    it('should count a ferret with no transcript as skipped, not selected', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', hasTranscript: true }),
        lessonFacts({ sessionId: 's2', hasTranscript: false }),
      ];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' } });

      // Assert
      should(result.sessionIds).deepEqual(['s1']);
      should(result.skipped).equal(1);
    });

    it('should exclude the miner-labelled session rather than count it as skipped', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', hasTranscript: true }),
        lessonFacts({ sessionId: 'miner-1', label: LESSON_MINER_LABEL, hasTranscript: false }),
      ];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' } });

      // Assert
      should(result.sessionIds).deepEqual(['s1']);
      should(result.skipped).equal(0);
    });

    it('should exclude passive ferrets from the not-passive scope', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', createdAt: '2024-05-01T09:00:00.000Z' }),
        lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:30:00.000Z' }),
      ];
      world.store.sessionLearning = [{ sessionId: 's2', passive: true, since: AT, setBy: 'owner' }];

      // Act
      const result = await world.service.estimate({ scope: { kind: 'not-passive' } });

      // Assert
      should(result.sessionIds).deepEqual(['s1']);
    });
  });

  // ── startScan ────────────────────────────────────────────────────────────────────────────────

  describe('startScan', () => {
    it('should refuse to start a second scan while one is running', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = { scan: scanRecord({ runId: 'scan-already', state: 'running' }) };

      // Act / Assert
      await should(world.service.startScan({ scope: { kind: 'not-passive' } })).be.rejectedWith({ reason: 'scan-running' });
    });

    it('should finish immediately with a message when nothing is in scope', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act
      const progress = await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(progress.state).equal('finished');
      should(progress.total).equal(0);
      should(progress.message).equal('no ferrets in this scope have a transcript to read');
      should(world.store.state.scan?.state).equal('finished');
    });

    it('should start no miner for a batch whose sessions have no digest, and count it done', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' }), lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:30:00.000Z' })];

      // Act
      const progress = await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(progress.state).equal('finished');
      should(progress.total).equal(2);
      should(progress.done).equal(2);
      should(progress.message).be.undefined();
    });

    it('should stay running while at least one batch started a miner', async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, batchSize: 1 };
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', createdAt: '2024-05-01T09:00:00.000Z' }),
        lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:30:00.000Z' }),
      ];
      world.miner.digests.set('s1', 100);

      // Act
      const progress = await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(progress.state).equal('running');
      should(progress.done).equal(1);
      should(progress.total).equal(2);
    });

    it("should batch sessions by the config's batchSize", async () => {
      // Arrange
      const world = lessonsWorld();
      world.config = { ...LEARNING_CONFIG, batchSize: 2 };
      world.sessions.sessions = [
        lessonFacts({ sessionId: 's1', createdAt: '2024-05-01T09:00:00.000Z' }),
        lessonFacts({ sessionId: 's2', createdAt: '2024-05-01T09:10:00.000Z' }),
        lessonFacts({ sessionId: 's3', createdAt: '2024-05-01T09:20:00.000Z' }),
      ];

      // Act
      await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(world.miner.starts.map(start => start.sessionIds)).deepEqual([
        ['s1', 's2'],
        ['s3'],
      ]);
    });

    it('should mint a runId from the current instant, with : and . replaced', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act
      const progress = await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(progress.runId).equal(`scan-${AT.replace(/[:.]/gu, '-')}`);
    });

    it('should save the started record into the store', async () => {
      // Arrange
      const world = lessonsWorld();
      world.sessions.sessions = [lessonFacts({ sessionId: 's1' })];

      // Act
      const progress = await world.service.startScan({ scope: { kind: 'not-passive' } });

      // Assert
      should(world.store.state.scan?.runId).equal(progress.runId);
      should(world.store.state.scan?.sessionIds).deepEqual(['s1']);
      should(world.store.state.scan?.startedAt).equal(AT);
    });
  });

  // ── scanProgress ─────────────────────────────────────────────────────────────────────────────

  describe('scanProgress', () => {
    it('should answer undefined when no scan has ever run', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress).be.undefined();
    });

    it('should return a non-running scan as is, without touching the miner', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = { scan: scanRecord({ state: 'finished', sessionIds: ['s1'], done: 1, finishedAt: AT }) };

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress?.state).equal('finished');
      should(world.miner.starts).have.length(0);
    });

    it('should stay running while a batch is still pending', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({ state: 'running', sessionIds: ['s1'], batches: [{ minerSessionId: 'miner-0', sessionIds: ['s1'] }] }),
      };

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress?.state).equal('running');
      should(progress?.done).equal(0);
    });

    it('should fold a collected batch into added/merged/done and finish with finishedAt', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({
          state: 'running',
          sessionIds: ['s1', 's2'],
          batches: [{ minerSessionId: 'miner-0', sessionIds: ['s1', 's2'] }],
        }),
      };
      world.miner.outcomes.set(0, { added: 3, merged: 1 });

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress?.state).equal('finished');
      should(progress?.done).equal(2);
      should(progress?.added).equal(3);
      should(progress?.merged).equal(1);
      should(progress?.finishedAt).equal(AT);
    });

    it('should mark the scan failed with a message when a miner wrote invalid output', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({
          state: 'running',
          sessionIds: ['s1'],
          batches: [{ minerSessionId: 'miner-0', sessionIds: ['s1'] }],
        }),
      };
      world.miner.outcomes.set(0, 'failed');

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress?.state).equal('failed');
      should(progress?.message).equal('a miner wrote output that was not valid; its ferrets were skipped');
    });

    it('should skip a batch with no miner session without asking the miner for it', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({
          state: 'running',
          sessionIds: ['x', 'y'],
          batches: [{ sessionIds: ['x'] }, { minerSessionId: 'miner-1', sessionIds: ['y'] }],
        }),
      };
      // A bogus outcome at the done batch's own index: it must never be read, since that batch has no
      // miner session and the loop skips straight past it.
      world.miner.outcomes.set(0, 'failed');

      // Act
      const progress = await world.service.scanProgress();

      // Assert
      should(progress?.state).equal('running');
      should(progress?.message).be.undefined();
    });
  });

  // ── cancelScan ───────────────────────────────────────────────────────────────────────────────

  describe('cancelScan', () => {
    it('should refuse to cancel when no scan has ever run', async () => {
      // Arrange
      const world = lessonsWorld();

      // Act / Assert
      await should(world.service.cancelScan()).be.rejectedWith({ reason: 'not-found' });
    });

    it('should return a non-running scan unchanged and stop nothing', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({ state: 'finished', sessionIds: ['s1'], done: 1, finishedAt: AT, batches: [{ minerSessionId: 'miner-0', sessionIds: ['s1'] }] }),
      };

      // Act
      const progress = await world.service.cancelScan();

      // Assert
      should(progress.state).equal('finished');
      should(world.miner.stopped).have.length(0);
    });

    it('should stop every running miner and mark the scan cancelled', async () => {
      // Arrange
      const world = lessonsWorld();
      world.store.state = {
        scan: scanRecord({
          state: 'running',
          sessionIds: ['s1', 's2'],
          batches: [
            { minerSessionId: 'miner-0', sessionIds: ['s1'] },
            { minerSessionId: 'miner-1', sessionIds: ['s2'] },
          ],
        }),
      };

      // Act
      const progress = await world.service.cancelScan();

      // Assert
      should(world.miner.stopped).deepEqual(['miner-0', 'miner-1']);
      should(progress.state).equal('cancelled');
      should(progress.message).equal('cancelled by the owner');
      should(world.store.state.scan?.state).equal('cancelled');
    });
  });
});
