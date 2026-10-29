import { describe, expect, it, test } from 'bun:test';
import type { LearningConfig, SessionView, StartSessionRequest } from '@ferretry/protocol';
import should from 'should';
import { LEARNING_MINER_LABEL, LearningMiner, normalizedRecord } from '../../../src/adapters/learning/miner.ts';
import type {
  LearningStorePort,
  Observation,
  Proposal,
  RunManifest,
  StoredSessionLearning,
  Tombstone,
} from '../../../src/lib/learning/index.ts';
import type { FoundationPaths } from '../../../src/lib/paths.ts';
import type { FileSystemPort } from '../../../src/lib/ports.ts';
import type { SessionControlSubsystem } from '../../../src/lib/runtime/mounts/session-control.ts';
import { withSystemCallsign } from '../../../src/lib/runtime/mounts/system-session-control.ts';
import type { SessionDirectorySubsystem } from '../../../src/lib/runtime/mounts/sessions.ts';
import type { SessionTranscriptReader } from '../../../src/lib/session/transcript/reader.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';
import { issuerOver } from '../names/system-callsigns-support.ts';

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
  passiveDefault: false,
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
  sessionLearning: StoredSessionLearning[] = [];
  async loadSessionLearning() {
    return this.sessionLearning;
  }
  async saveSessionLearning(items: readonly StoredSessionLearning[]) {
    this.sessionLearning = [...items];
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

test('mines the sessions it can prove and says how many it skipped for missing provenance', async () => {
  const store = new Store();
  const requests: StartSessionRequest[] = [];
  const miner = new LearningMiner(
    paths,
    files({
      '/daemon/state/sessions/session-1/turns/turn-001.md': 'Use direnv exec . for every command.',
      '/daemon/state/sessions/session-1/channel/inbox.jsonl':
        '{"type":"message","message":"Use direnv exec . for every command."}\n',
      '/daemon/state/sessions/session-1/events.jsonl': '',
    }),
    store,
    {
      list: async () => [session(false, 'session-0'), session()],
      get: async () => undefined,
    } as SessionDirectorySubsystem,
    {
      tail: async () => [{ type: 'chat.user', timestamp: AT, data: { text: 'Use direnv exec . for every command.' } }],
    } as unknown as SessionTranscriptReader,
    {
      start: async (request: StartSessionRequest) => {
        requests.push(request);
        return session();
      },
    } as unknown as SessionControlSubsystem,
    () => config,
    () => AT,
  );

  const run = await miner.run(true);

  expect(requests).toHaveLength(1);
  expect(run.minerSessions).toEqual(['session-1']);
  expect(run.sessionsWithSignal).toBe(1);
  expect(run.message).toBe('skipped 1 session(s) with missing or unresolved transcript provenance');
  expect((await store.latestRunManifest())?.message).toBe(run.message);
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

test('drops a malformed miner entry alone and keeps the rest of the run', async () => {
  const store = new Store();
  const filesystem = files({
    '/daemon/state/sessions/session-1/turns/turn-001.md': 'Use direnv exec . for every command.',
    '/daemon/state/sessions/session-1/channel/inbox.jsonl':
      '{"type":"message","message":"Use direnv exec . for every command."}\n{"type":"message","message":7}\n',
    '/daemon/state/sessions/session-1/events.jsonl': '"not an event"\n{"type":"control.interrupted"}\n',
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
    JSON.stringify({
      observations: [
        { key: 'bad', sessionId: 'session-1', kind: 'correction', gist: 'Use direnv', quote: 5 },
        {
          key: 'o1',
          sessionId: 'session-1',
          kind: 'correction',
          gist: 'Use direnv',
          quote: 'Use direnv exec . for every command.',
        },
      ],
      proposals: [
        { title: 'Odd anchor', ruleText: 'Anchor is a number', anchor: 7, observationKeys: ['o1'] },
        { title: 'Use direnv', ruleText: 'Use direnv exec .', observationKeys: ['o1'] },
      ],
    }),
  );

  const run = await miner.run(false);

  expect(run.message).toBeUndefined();
  expect(store.observations.map(item => item.quote)).toEqual(['Use direnv exec . for every command.']);
  expect(store.proposals.map(item => item.title)).toEqual(['Use direnv']);
  expect(store.proposals[0]?.target.anchor).toBe('## Agent rules');
});

test('quarantines a miner output that is JSON but not an output document', async () => {
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
    JSON.stringify({ observations: 'none' }),
  );

  const run = await miner.run(false);

  expect(run.message).toBe('miner output was not valid JSON — quarantined');
  expect(store.observations).toHaveLength(0);
});

// ── The scan port: normalized records, per-ferret digests, one miner per batch ─────────────────────

const SCAN_SAYS = 'Use direnv exec . for every command.';
const SCAN_RUN = '/daemon/state/learning/runs/scan-1-b0';

const userEvent = (text: string, timestamp?: string): TranscriptEvent => ({
  kind: 'message',
  role: 'user',
  harness: 'claude',
  text,
  ...(timestamp === undefined ? {} : { timestamp }),
});

/** A view with its status and label changed; the rest of the fixture as `session()` builds it. */
function viewOf(
  base: SessionView,
  patch: { readonly status?: SessionView['state']['status']; readonly label?: string },
): SessionView {
  return {
    ...base,
    config: { ...base.config, ...(patch.label === undefined ? {} : { label: patch.label }) },
    state: { ...base.state, ...(patch.status === undefined ? {} : { status: patch.status }) },
  };
}

interface ScanWorld {
  readonly miner: LearningMiner;
  readonly store: Store;
  readonly filesystem: FileSystemPort;
  readonly started: StartSessionRequest[];
  readonly startIds: string[];
  readonly stopped: [string, string][];
  /** The sessions the directory answers, by id; a case may swap one in. */
  readonly views: Map<string, SessionView>;
}

function scanWorld(
  events: readonly TranscriptEvent[] = [userEvent('First.'), userEvent(SCAN_SAYS, AT)],
  wrap: (control: SessionControlSubsystem) => SessionControlSubsystem = control => control,
): ScanWorld {
  const store = new Store();
  const filesystem = files({});
  const started: StartSessionRequest[] = [];
  const startIds: string[] = [];
  const stopped: [string, string][] = [];
  const views = new Map<string, SessionView>([
    ['session-1', session()],
    ['bare', session(false, 'bare')],
    ['miner-own', viewOf(session(true, 'miner-own'), { label: LEARNING_MINER_LABEL })],
  ]);
  const control = {
    start: async (request: StartSessionRequest, requestId: string) => {
      started.push(request);
      startIds.push(requestId);
      const miner = viewOf(session(true, 'miner-1'), { status: 'running', label: LEARNING_MINER_LABEL });
      views.set('miner-1', miner);
      return miner;
    },
    stop: async (sessionId: string, reason: string) => {
      stopped.push([sessionId, reason]);
      return session();
    },
    recover: async () => undefined,
  } as unknown as SessionControlSubsystem;
  const miner = new LearningMiner(
    paths,
    filesystem,
    store,
    { list: async () => [...views.values()], get: async id => views.get(id) } as SessionDirectorySubsystem,
    { tail: async () => events } as unknown as SessionTranscriptReader,
    wrap(control),
    () => config,
    () => AT,
  );
  return { miner, store, filesystem, started, startIds, stopped, views };
}

const scanManifest = (patch: Partial<RunManifest> = {}): RunManifest => ({
  runId: 'scan-1-b0',
  startedAt: AT,
  sessionsScanned: 1,
  sessionsWithSignal: 1,
  minerSessions: ['miner-1'],
  observationsProposed: 0,
  observationsVerified: 0,
  rejectedQuotes: 0,
  malformedFiles: 0,
  proposalsCreated: 0,
  proposalsStrengthened: 0,
  proposalsSuppressedByTombstone: 0,
  perHarness: { claude: 0, codex: 0 },
  ...patch,
});

describe('normalizedRecord', () => {
  it('should read a user message as chat.user with its text and timestamp', () => {
    // Act
    const record = normalizedRecord(userEvent('Hello.', AT));

    // Assert
    should(record).deepEqual({ type: 'chat.user', timestamp: AT, data: { text: 'Hello.' } });
  });

  it("should not read the harness's own event as the owner's message", () => {
    // Act
    const record = normalizedRecord({
      ...userEvent('<task-notification>…</task-notification>', AT),
      inputSource: 'harness',
    });

    // Assert
    should(record).deepEqual({ type: 'message', timestamp: AT });
  });

  it('should read a tool result as tool.result with its error flag', () => {
    // Act
    const record = normalizedRecord({
      kind: 'tool-result',
      role: 'tool',
      harness: 'claude',
      timestamp: AT,
      result: { callId: 'c1', content: null, isError: true },
    });

    // Assert
    should(record).deepEqual({ type: 'tool.result', timestamp: AT, data: { isError: true } });
  });

  it('should read any other event by its kind alone, without a timestamp it does not have', () => {
    // Act
    const assistant = normalizedRecord({ kind: 'message', role: 'assistant', harness: 'claude', text: 'Done.' });
    const reasoning = normalizedRecord({
      kind: 'reasoning',
      role: 'assistant',
      harness: 'claude',
      text: 'Hmm.',
      format: 'thinking',
    });

    // Assert
    should(assistant).deepEqual({ type: 'message' });
    should(reasoning).deepEqual({ type: 'reasoning' });
  });
});

describe('LearningMiner scan', () => {
  it('should count no digest for an unknown, a miner, an unresolved, or a signal-less session', async () => {
    // Arrange
    const { miner } = scanWorld();
    const { miner: quiet } = scanWorld([userEvent('Only one message.')]);

    // Act
    const unknown = await miner.digestCharacters('missing');
    const own = await miner.digestCharacters('miner-own');
    const bare = await miner.digestCharacters('bare');
    const silent = await quiet.digestCharacters('session-1');

    // Assert
    should(unknown).be.undefined();
    should(own).be.undefined();
    should(bare).be.undefined();
    should(silent).be.undefined();
  });

  it('should count the digest characters of a session with signal', async () => {
    // Arrange
    const { miner } = scanWorld();

    // Act
    const characters = await miner.digestCharacters('session-1');

    // Assert
    should(characters).be.a.Number().and.be.above(0);
  });

  it('should start no miner when no session in the batch has anything to mine', async () => {
    // Arrange
    const { miner, started, store } = scanWorld();

    // Act
    const id = await miner.start('scan-1', 0, ['missing', 'bare'], 'claude', 'opus');

    // Assert
    should(id).be.undefined();
    should(started).deepEqual([]);
    should(store.manifests.size).equal(0);
  });

  it('should write the digests, start a labelled miner with its model, and record the batch manifest', async () => {
    // Arrange
    const { miner, started, startIds, store, filesystem } = scanWorld();

    // Act
    const id = await miner.start('scan-1', 0, ['session-1', 'bare'], 'claude', 'opus');

    // Assert
    should(id).equal('miner-1');
    should(startIds).deepEqual(['learning:scan-1-b0']);
    should(started[0]).containDeep({
      agent: 'claude',
      mode: 'auto',
      label: LEARNING_MINER_LABEL,
      name: 'Lesson Scan',
      cwd: '/daemon',
      boardAccess: 'none',
      model: 'opus',
    });
    should(started[0]?.prompt).containEql(`${SCAN_RUN}/observations.json`);
    const digests = JSON.parse((await filesystem.readText(`${SCAN_RUN}/digests.json`)) ?? '[]') as {
      sessionId: string;
    }[];
    should(digests.map(digest => digest.sessionId)).deepEqual(['session-1']);
    should(store.manifests.get('scan-1-b0')).containDeep({
      runId: 'scan-1-b0',
      sessionsScanned: 2,
      sessionsWithSignal: 1,
      minerSessions: ['miner-1'],
    });
  });

  it('should leave the model to the agent when none is given', async () => {
    // Arrange
    const { miner, started } = scanWorld();

    // Act
    await miner.start('scan-1', 0, ['session-1'], 'claude', undefined);

    // Assert
    should(started[0]).not.have.property('model');
  });

  it('should fail a batch that has no manifest', async () => {
    // Arrange
    const { miner } = scanWorld();

    // Act
    const outcome = await miner.collect('scan-1', 4);

    // Assert
    should(outcome).equal('failed');
  });

  it('should answer the stats of a finished batch, and fail a finished malformed one', async () => {
    // Arrange
    const { miner, store } = scanWorld();
    await store.writeRunManifest(
      scanManifest({ runId: 'scan-1-b0', finishedAt: AT, proposalsCreated: 2, proposalsStrengthened: 3 }),
    );
    await store.writeRunManifest(scanManifest({ runId: 'scan-1-b1', finishedAt: AT, malformedFiles: 1 }));

    // Act
    const finished = await miner.collect('scan-1', 0);
    const malformed = await miner.collect('scan-1', 1);

    // Assert
    should(finished).deepEqual({ added: 2, merged: 3 });
    should(malformed).equal('failed');
  });

  it('should fold a written output into the board and answer its stats', async () => {
    // Arrange
    const { miner, store, filesystem } = scanWorld();
    await miner.start('scan-1', 0, ['session-1'], 'claude', undefined);
    await filesystem.writeTextAtomic(
      `${SCAN_RUN}/observations.json`,
      JSON.stringify({
        observations: [{ key: 'o1', sessionId: 'session-1', kind: 'correction', gist: 'Use direnv', quote: SCAN_SAYS }],
        proposals: [{ title: 'Use direnv', ruleText: 'Use direnv exec .', observationKeys: ['o1'] }],
      }),
    );

    // Act
    const outcome = await miner.collect('scan-1', 0);

    // Assert
    should(outcome).deepEqual({ added: 1, merged: 0 });
    should(store.proposals.map(item => item.title)).deepEqual(['Use direnv']);
    should(store.manifests.get('scan-1-b0')?.finishedAt).equal(AT);
  });

  it('should keep a batch pending while its miner still runs', async () => {
    // Arrange
    const { miner, store } = scanWorld();
    await miner.start('scan-1', 0, ['session-1'], 'claude', undefined);

    // Act
    const outcome = await miner.collect('scan-1', 0);

    // Assert
    should(outcome).equal('pending');
    should(store.manifests.get('scan-1-b0')?.finishedAt).be.undefined();
  });

  it('should fail and finish a batch whose miner ended without writing its output', async () => {
    // Arrange
    const { miner, store, views } = scanWorld();
    await miner.start('scan-1', 0, ['session-1'], 'claude', undefined);
    views.set('miner-1', viewOf(session(true, 'miner-1'), { status: 'completed' }));

    // Act
    const outcome = await miner.collect('scan-1', 0);

    // Assert
    should(outcome).equal('failed');
    should(store.manifests.get('scan-1-b0')).containDeep({
      finishedAt: AT,
      malformedFiles: 1,
      message: 'the miner ended without writing its output',
    });
  });

  it('should fail a batch whose miner is unknown or was never recorded', async () => {
    // Arrange
    const { miner, store } = scanWorld();
    await store.writeRunManifest(scanManifest({ runId: 'scan-1-b0', minerSessions: ['gone'] }));
    await store.writeRunManifest(scanManifest({ runId: 'scan-1-b1', minerSessions: [] }));

    // Act
    const gone = await miner.collect('scan-1', 0);
    const never = await miner.collect('scan-1', 1);

    // Assert
    should([gone, never]).deepEqual(['failed', 'failed']);
    should(store.manifests.get('scan-1-b1')?.message).equal('the miner ended without writing its output');
  });

  it('should stop a miner on the owner cancelling the scan', async () => {
    // Arrange
    const { miner, stopped } = scanWorld();

    // Act
    await miner.stop('miner-1');

    // Assert
    should(stopped).deepEqual([['miner-1', 'lesson scan cancelled by the owner']]);
  });
});

describe('the callsign of a learning session', () => {
  const LEARNING = /^learning-[0-9a-f]{6}$/u;

  it('should start a lesson scan under a learning id, never a first name', async () => {
    // Arrange
    const issuer = issuerOver();
    const { miner, started } = scanWorld(undefined, control => withSystemCallsign(control, issuer, 'learning'));

    // Act
    await miner.start('scan-1', 0, ['session-1'], 'claude', 'opus');

    // Assert
    should(started[0]?.name).equal('Lesson Scan');
    should(started[0]?.teammate).equal('learning-000001');
  });

  it('should start a batch miner under the same shared counter', async () => {
    // Arrange
    const issuer = issuerOver();
    const requests: StartSessionRequest[] = [];
    const inner = {
      start: async (request: StartSessionRequest) => {
        requests.push(request);
        return session();
      },
      stop: async () => session(),
      recover: async () => undefined,
    } as SessionControlSubsystem;
    const miner = new LearningMiner(
      paths,
      files({
        '/daemon/state/sessions/session-1/turns/turn-001.md': 'Use direnv exec . for every command.',
        '/daemon/state/sessions/session-1/channel/inbox.jsonl':
          '{"type":"message","message":"Use direnv exec . for every command."}\n',
        '/daemon/state/sessions/session-1/events.jsonl': '',
      }),
      new Store(),
      { list: async () => [session()], get: async () => undefined } as SessionDirectorySubsystem,
      {
        tail: async () => [
          { type: 'chat.user', timestamp: AT, data: { text: 'Use direnv exec . for every command.' } },
        ],
      } as unknown as SessionTranscriptReader,
      withSystemCallsign(inner, issuer, 'learning'),
      () => config,
      () => AT,
    );

    // Act
    await miner.run(true);
    const next = await issuer.next('learning');

    // Assert
    should(requests[0]?.name).equal('Learning Miner');
    should(requests[0]?.teammate).match(LEARNING);
    should(next).equal('learning-000002');
  });
});
