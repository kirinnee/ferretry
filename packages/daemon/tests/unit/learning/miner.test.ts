import { expect, test } from 'bun:test';
import type { LearningConfig, SessionView } from '@ferretry/protocol';
import { LearningMiner } from '../../../src/adapters/learning/miner.ts';
import type {
  LearningStorePort,
  Observation,
  Proposal,
  RunManifest,
  Tombstone,
} from '../../../src/lib/learning/index.ts';
import type { FoundationPaths } from '../../../src/lib/paths.ts';
import type { FileSystemPort } from '../../../src/lib/ports.ts';
import type { SessionDirectorySubsystem } from '../../../src/lib/runtime/mounts/sessions.ts';
import type { SessionControlSubsystem } from '../../../src/lib/runtime/mounts/session-control.ts';
import type { SessionTranscriptReader } from '../../../src/lib/session/transcript/reader.ts';

const AT = '2026-08-01T00:00:00.000Z';
const paths = { home: '/daemon', state: '/daemon/state' } as FoundationPaths;
const config: LearningConfig = {
  enabled: true,
  agent: 'claude',
  intervalMinutes: 60,
  batchSize: 20,
  maxMinersPerRun: 2,
  maxSessionsPerRun: 40,
  minSpawnGapMinutes: 30,
};

function session(transcript = true, id = 'session-1'): SessionView {
  return {
    directory: `/daemon/state/sessions/${id}`,
    config: {
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: 'Complete task',
      boardAccess: 'none',
      agent: 'claude',
      harness: 'claude',
      modelHint: '',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/repo',
      createdAt: AT,
      updatedAt: AT,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      ...(transcript
        ? {
            transcript: {
              v: 1,
              home: '/harness',
              harnessSessionId: 'h1',
              identity: 'minted' as const,
              file: '/harness/h1.jsonl',
              resolvedAt: AT,
            },
          }
        : {}),
    },
    state: { id, status: 'completed', turn: 1, finishedAt: AT },
  };
}

class Store implements LearningStorePort {
  state = {};
  observations: Observation[] = [];
  proposals: Proposal[] = [];
  tombstones: Tombstone[] = [];
  manifests = new Map<string, RunManifest>();
  async ensureDirectories() {}
  async loadState() {
    return this.state;
  }
  async saveState(state: typeof this.state) {
    this.state = state;
  }
  async readObservations() {
    return this.observations;
  }
  async observationsById() {
    return new Map(this.observations.map(item => [item.id, item]));
  }
  async appendObservations(items: readonly Observation[]) {
    this.observations.push(...items);
    return items;
  }
  async loadProposals() {
    return this.proposals;
  }
  async saveProposals(items: readonly Proposal[]) {
    this.proposals = [...items];
  }
  async loadTombstones() {
    return this.tombstones;
  }
  async saveTombstones(items: readonly Tombstone[]) {
    this.tombstones = [...items];
  }
  async writeRunManifest(manifest: RunManifest) {
    this.manifests.set(manifest.runId, manifest);
  }
  async readRunManifest(id: string) {
    return this.manifests.get(id);
  }
  async latestRunManifest() {
    return [...this.manifests.values()].at(-1);
  }
  async writePatch() {
    return '/patch';
  }
}

function files(initial: Record<string, string>): FileSystemPort {
  const text = new Map(Object.entries(initial));
  return {
    ensureDirectory: async () => {},
    setMode: async () => {},
    information: async () => undefined,
    readChunks: async function* () {},
    readSlice: async () => undefined,
    listDirectory: async path =>
      path.endsWith('/turns')
        ? [{ name: 'turn-001.md', directory: false }]
        : path.endsWith('/runs')
          ? [{ name: '2026-08-01T00-00-00-000Z', directory: true }]
          : [],
    readText: async path => text.get(path),
    writeTextAtomic: async (path, value) => {
      text.set(path, value);
    },
    createFileExclusive: async () => ({ device: '1', inode: '1', size: 0, modifiedAtMs: 0 }),
    appendLineDurable: async () => ({
      byteOffset: 0,
      byteLength: 0,
      fingerprint: { device: '1', inode: '1', size: 0, modifiedAtMs: 0 },
    }),
    appendLineToExisting: async () => ({ kind: 'absent' }),
    removeFile: async path => {
      text.delete(path);
    },
    sweepTemporaryFiles: async () => {},
  };
}

test('mines only a session with resolved provenance and aggregates verified output', async () => {
  const store = new Store();
  const filesystem = files({
    '/daemon/state/sessions/session-1/turns/turn-001.md': 'Use direnv exec . for every command.',
    '/daemon/state/sessions/session-1/channel/inbox.jsonl':
      '{"type":"message","message":"Use direnv exec . for every command."}\n',
    '/daemon/state/sessions/session-1/events.jsonl': '',
  });
  const miner = new LearningMiner(
    paths,
    filesystem,
    store,
    {
      list: async () => [session(true, 'session-2'), session()],
      get: async () => undefined,
    } as SessionDirectorySubsystem,
    {
      tail: async () => [{ type: 'chat.user', timestamp: AT, data: { text: 'Use direnv exec . for every command.' } }],
    } as unknown as SessionTranscriptReader,
    {
      start: async () => session(),
      stop: async () => session(),
      recover: async () => undefined,
    } as SessionControlSubsystem,
    () => config,
    () => AT,
  );
  const pending = await miner.run(true);
  expect(pending.minerSessions).toEqual(['session-1']);
  await filesystem.writeTextAtomic(
    '/daemon/state/learning/runs/2026-08-01T00-00-00-000Z/observations.json',
    JSON.stringify({
      observations: [
        {
          key: 'o1',
          sessionId: 'session-1',
          kind: 'correction',
          gist: 'Use direnv',
          quote: 'Use direnv exec . for every command.',
        },
      ],
      proposals: [{ title: 'Use direnv', ruleText: 'Use direnv exec .', observationKeys: ['o1'] }],
    }),
  );
  await miner.run(false);
  expect(store.observations).toHaveLength(1);
  expect(store.proposals).toHaveLength(1);
});

test('reports missing provenance rather than mining a partial conversation', async () => {
  const store = new Store();
  const miner = new LearningMiner(
    paths,
    files({}),
    store,
    { list: async () => [session(false)], get: async () => undefined } as SessionDirectorySubsystem,
    {} as SessionTranscriptReader,
    {} as SessionControlSubsystem,
    () => config,
    () => AT,
  );
  const run = await miner.run(true);
  expect(run.message).toContain('missing or unresolved transcript provenance');
});

test('does not spawn when a resolved transcript contains no human signal', async () => {
  const store = new Store();
  const miner = new LearningMiner(
    paths,
    files({}),
    store,
    { list: async () => [session()], get: async () => undefined } as SessionDirectorySubsystem,
    { tail: async () => [] } as unknown as SessionTranscriptReader,
    {} as SessionControlSubsystem,
    () => config,
    () => AT,
  );

  const run = await miner.run(true);

  expect(run.message).toBe('no human signal in the scanned batch');
});

test('completes a malformed miner output without applying it', async () => {
  const store = new Store();
  const filesystem = files({
    '/daemon/state/sessions/session-1/turns/turn-001.md': 'Use direnv exec . for every command.',
    '/daemon/state/sessions/session-1/channel/inbox.jsonl':
      '{"type":"message","message":"Use direnv exec . for every command."}\n',
    '/daemon/state/sessions/session-1/events.jsonl': '',
  });
  const miner = new LearningMiner(
    paths,
    filesystem,
    store,
    { list: async () => [session()], get: async () => undefined } as SessionDirectorySubsystem,
    {
      tail: async () => [{ type: 'chat.user', timestamp: AT, data: { text: 'Use direnv exec . for every command.' } }],
    } as unknown as SessionTranscriptReader,
    {
      start: async () => session(),
      stop: async () => session(),
      recover: async () => undefined,
    } as SessionControlSubsystem,
    () => config,
    () => AT,
  );
  await miner.run(true);
  await filesystem.writeTextAtomic(
    '/daemon/state/learning/runs/2026-08-01T00-00-00-000Z/observations.json',
    'not json',
  );

  const run = await miner.run(false);

  expect(run.message).toBe('miner output was not valid JSON — quarantined');
  expect(store.observations).toHaveLength(0);
});

test('records an empty run when its watermark has no newer terminal sessions', async () => {
  const store = new Store();
  await store.saveState({ watermarkAt: '9999-12-31T23:59:59.999Z', watermarkId: 'future' });
  const miner = new LearningMiner(
    paths,
    files({}),
    store,
    { list: async () => [session()], get: async () => undefined } as SessionDirectorySubsystem,
    {} as SessionTranscriptReader,
    {} as SessionControlSubsystem,
    () => config,
    () => AT,
  );

  const run = await miner.run(true);

  expect(run.message).toBe('no new terminal sessions to scan');
});
