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
    await writeFile(join(learningDirectory, 'observations.jsonl'), '{"id":"valid"}\n{broken\n');

    // Act
    const state = await store.loadState();
    const proposals = await store.loadProposals();
    const tombstones = await store.loadTombstones();
    const observations = await store.readObservations();

    // Assert
    should(state).deepEqual({});
    should(proposals).deepEqual([]);
    should(tombstones).deepEqual([]);
    should(observations).deepEqual([{ id: 'valid' }]);
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
});
