import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import type { Proposal, RunManifest } from '../../../src/lib/learning/index.ts';
import type { Observation } from '../../../src/lib/learning/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { FileLearningStore, StateFileSystem } from '../../../src/adapters/index.ts';

const homes = new Set<string>();
const now = '2026-07-30T12:00:00.000Z';

async function createStore(): Promise<{ readonly home: string; readonly store: FileLearningStore }> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-learning-store-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: '/unused' }));
  const files = new StateFileSystem(paths, () => 'temporary-file');
  await files.ensureDirectory(paths.home, 0o700);
  await files.ensureDirectory(paths.state, 0o700);
  await files.ensureDirectory(paths.temporary, 0o700);
  return { home, store: new FileLearningStore(paths, files, { now: () => now }) };
}

const observation = (id: string): Observation => ({
  id,
  sessionId: `session-${id}`,
  mode: 'auto',
  cwd: '/repo',
  repo: '/repo',
  at: now,
  kind: 'preference',
  gist: 'Use a safe environment.',
  quote: 'Use direnv exec.',
  source: 'human',
  verified: true,
  runId: 'run-1',
});

const proposal: Proposal = {
  id: 'proposal-1',
  category: 'global',
  state: 'pending',
  title: 'Use safe environment',
  ruleText: 'Use direnv exec .',
  target: { kind: 'global-agent-guidance', path: 'guidance.md' },
  observationIds: ['one'],
  occurrences: 1,
  crossRepoCount: 1,
  firstSeen: now,
  lastSeen: now,
  identity: 'use-safe-environment',
  history: [{ at: now, event: 'proposed:run-1', by: 'miner' }],
  source: 'scan',
  count: 1,
};

const manifest = (runId: string): RunManifest => ({
  runId,
  startedAt: now,
  sessionsScanned: 1,
  sessionsWithSignal: 1,
  minerSessions: ['miner-1'],
  observationsProposed: 1,
  observationsVerified: 1,
  rejectedQuotes: 0,
  malformedFiles: 0,
  proposalsCreated: 1,
  proposalsStrengthened: 0,
  proposalsSuppressedByTombstone: 0,
  perHarness: { claude: 1, codex: 0 },
});

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

describe('file learning store', () => {
  it('should create private directories and append each observation at most once', async () => {
    // Arrange
    const { home, store } = await createStore();

    // Act
    await store.ensureDirectories();
    const first = await store.appendObservations([observation('one'), observation('one'), observation('two')]);
    const second = await store.appendObservations([observation('one')]);
    const all = await store.readObservations();
    const index = await store.observationsById();

    // Assert
    should(first.map(item => item.id)).deepEqual(['one', 'two']);
    should(second).deepEqual([]);
    should(all.map(item => item.id)).deepEqual(['one', 'two']);
    should([...index.keys()]).deepEqual(['one', 'two']);
    should((await stat(join(home, 'state', 'learning'))).mode & 0o777).equal(0o700);
    should((await stat(join(home, 'state', 'learning', 'observations.jsonl'))).mode & 0o777).equal(0o600);
  });

  it('should recover empty defaults from missing or corrupt JSON documents', async () => {
    // Arrange
    const { home, store } = await createStore();
    const learningDirectory = join(home, 'state', 'learning');
    await store.ensureDirectories();
    await writeFile(join(learningDirectory, 'state.json'), '{broken');
    await writeFile(join(learningDirectory, 'proposals.json'), '{broken');
    await writeFile(join(learningDirectory, 'tombstones.json'), '{broken');
    await writeFile(
      join(learningDirectory, 'observations.jsonl'),
      `${JSON.stringify(observation('valid'))}\n{broken\n`,
    );

    // Act
    const state = await store.loadState();
    const proposals = await store.loadProposals();
    const tombstones = await store.loadTombstones();
    const observations = await store.readObservations();

    // Assert
    should(state).deepEqual({});
    should(proposals).deepEqual([]);
    should(tombstones).deepEqual([]);
    should(observations).deepEqual([observation('valid')]);
  });

  it('should drop records that are JSON but not the shape the store wrote, one record at a time', async () => {
    // Arrange
    const { home, store } = await createStore();
    const learningDirectory = join(home, 'state', 'learning');
    const tombstone = { identity: 'old', titleHash: 'hash', ruleGist: 'old rule', rejectedAt: now };
    await store.ensureDirectories();
    await writeFile(join(learningDirectory, 'state.json'), JSON.stringify({ watermarkAt: 7 }));
    await writeFile(
      join(learningDirectory, 'proposals.json'),
      JSON.stringify([{ ...proposal, id: 'bad', target: { kind: 'global-agent-guidance', anchor: 7 } }, proposal]),
    );
    await writeFile(join(learningDirectory, 'tombstones.json'), JSON.stringify([{ identity: 1 }, tombstone]));
    await writeFile(
      join(learningDirectory, 'observations.jsonl'),
      `${JSON.stringify({ id: 'shapeless' })}\n${JSON.stringify(observation('one'))}\n`,
    );
    await store.writeRunManifest(manifest('run-a'));
    await writeFile(join(learningDirectory, 'runs', 'run-a', 'manifest.json'), JSON.stringify({ runId: 'run-a' }));

    // Act
    const state = await store.loadState();
    const proposals = await store.loadProposals();
    const tombstones = await store.loadTombstones();
    const observations = await store.readObservations();
    const read = await store.readRunManifest('run-a');

    // Assert
    should(state).deepEqual({});
    should(proposals).deepEqual([proposal]);
    should(tombstones).deepEqual([tombstone]);
    should(observations).deepEqual([observation('one')]);
    should(read).be.undefined();
  });

  it('should read back a proposal whose evidence has all been pruned', async () => {
    // Arrange: the counters are recomputed from surviving evidence, so the daemon itself can write
    // a proposal the wire contract's one-or-more would refuse; reading must not delete it.
    const { store } = await createStore();
    const pruned = { ...proposal, observationIds: [], occurrences: 0, crossRepoCount: 0 };
    await store.saveProposals([pruned]);

    // Act
    const proposals = await store.loadProposals();

    // Assert
    should(proposals).deepEqual([pruned]);
  });

  it('should round-trip state, proposals, tombstones, manifests, and the newest manifest', async () => {
    // Arrange
    const { store } = await createStore();
    const tombstones = [{ identity: 'old', titleHash: 'hash', ruleGist: 'old rule', rejectedAt: now }];

    // Act
    await store.saveState({ watermarkAt: now, lastRunId: 'run-b' });
    await store.saveProposals([proposal]);
    await store.saveTombstones(tombstones);
    await store.writeRunManifest(manifest('run-a'));
    await store.writeRunManifest(manifest('run-b'));
    const state = await store.loadState();
    const proposals = await store.loadProposals();
    const restoredTombstones = await store.loadTombstones();
    const read = await store.readRunManifest('run-a');
    const missing = await store.readRunManifest('missing');
    const latest = await store.latestRunManifest();

    // Assert
    should(state).deepEqual({ watermarkAt: now, lastRunId: 'run-b' });
    should(proposals).deepEqual([proposal]);
    should(restoredTombstones).deepEqual(tombstones);
    should(read).deepEqual(manifest('run-a'));
    should(missing).be.undefined();
    should(latest).deepEqual(manifest('run-b'));
  });

  it('should handle an empty run directory, reject path traversal, and write a timestamped hand-off patch', async () => {
    // Arrange
    const { home, store } = await createStore();

    // Act
    const none = await store.latestRunManifest();
    const patch = await store.writePatch('A rule to apply!', '# Apply me\n');
    const traversal = await (async () => {
      try {
        await store.readRunManifest('../outside');
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    // Assert
    should(none).be.undefined();
    should(patch).equal(join(home, 'state', 'learning', 'patches', 'a-rule-to-apply-2026-07-30T12-00-00-000Z.md'));
    should(traversal).be.instanceOf(Error);
    should(String(traversal)).containEql('path-safe segment');
  });

  it('should round-trip session learning and drop a malformed entry alone', async () => {
    // Arrange
    const { home, store } = await createStore();
    const records = [
      { sessionId: 'session-1', passive: true, since: now, setBy: 'owner' as const },
      { sessionId: 'session-2', passive: false, since: now, setBy: 'default' as const },
    ];

    // Act
    const empty = await store.loadSessionLearning();
    await store.saveSessionLearning(records);
    const saved = await store.loadSessionLearning();
    await writeFile(
      join(home, 'state', 'learning', 'sessions.json'),
      JSON.stringify([{ sessionId: '', passive: 'yes' }, records[0]]),
    );
    const repaired = await store.loadSessionLearning();

    // Assert
    should(empty).deepEqual([]);
    should(saved).deepEqual(records);
    should(repaired).deepEqual([records[0]]);
  });

  it('should read a legacy proposal without source or count as a scan counted by its evidence', async () => {
    // Arrange
    const { home, store } = await createStore();
    const { source: _source, count: _count, ...legacy } = proposal;
    await store.ensureDirectories();
    await writeFile(
      join(home, 'state', 'learning', 'proposals.json'),
      JSON.stringify([
        { ...legacy, id: 'two', observationIds: ['one', 'two'] },
        { ...legacy, id: 'none', observationIds: [], occurrences: 0, crossRepoCount: 0 },
      ]),
    );

    // Act
    const proposals = await store.loadProposals();

    // Assert
    should(proposals.map(item => [item.id, item.source, item.count])).deepEqual([
      ['two', 'scan', 2],
      ['none', 'scan', 1],
    ]);
  });
});
