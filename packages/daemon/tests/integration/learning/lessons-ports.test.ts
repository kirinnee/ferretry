/**
 * The lessons domain's ports over the real world: the session directory and transcripts (faked at
 * their seam), the instruction files on a real disk, the fleet's lessons component, a ferret's
 * channel, and the price list.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccountModel, parseAccountModel } from '@ferretry/fleet';
import type { AnalyticsPricingRate, SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  CatalogPrices,
  DirectoryLessonSessions,
  type FleetConfigAccess,
  FleetGlobalLessons,
  lessonSessionFacts,
  NodeLessonFiles,
  SessionPassiveChannel,
} from '../../../src/adapters/learning/lessons-ports.ts';
import type { SessionDirectorySubsystem } from '../../../src/lib/runtime/mounts/sessions.ts';
import type { SessionTranscriptReader } from '../../../src/lib/session/transcript/reader.ts';
import type { TranscriptEvent, TranscriptHarness } from '../../../src/lib/transcript/types.ts';

const CREATED = '2026-10-01T00:00:00.000Z';
const UPDATED = '2026-10-02T00:00:00.000Z';

interface SessionPatch {
  readonly id?: string;
  readonly harness?: 'claude' | 'codex';
  readonly teammate?: string;
  readonly label?: string;
  readonly status?: SessionView['state']['status'];
  readonly transcript?: boolean;
}

function session(patch: SessionPatch = {}): SessionView {
  const id = patch.id ?? 'session-1';
  return {
    directory: `/daemon/state/sessions/${id}`,
    config: {
      id,
      incarnation: `${id}-1`,
      runtimeGeneration: 1,
      name: 'Complete task',
      agent: 'claude',
      harness: patch.harness ?? 'claude',
      modelHint: '',
      mode: 'interactive',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/repo',
      createdAt: CREATED,
      updatedAt: UPDATED,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
      ...(patch.teammate === undefined ? {} : { teammate: patch.teammate }),
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.transcript === true
        ? {
            transcript: {
              v: 1,
              home: '/harness',
              harnessSessionId: 'h1',
              identity: 'minted' as const,
              file: '/harness/h1.jsonl',
              resolvedAt: CREATED,
            },
          }
        : {}),
    },
    state: { id, status: patch.status ?? 'running', turn: 1 },
  };
}

class FakeDirectory implements SessionDirectorySubsystem {
  constructor(private readonly views: readonly SessionView[]) {}

  async list(): Promise<readonly SessionView[]> {
    return this.views;
  }

  async get(sessionId: string): Promise<SessionView | undefined> {
    return this.views.find(view => view.config.id === sessionId);
  }
}

class FakeTranscripts {
  readonly calls: { readonly sessionId: string; readonly harness: TranscriptHarness; readonly limit: number }[] = [];

  constructor(private readonly events: readonly TranscriptEvent[]) {}

  async tail(
    target: { readonly sessionId: string; readonly harness: TranscriptHarness },
    limit: number,
  ): Promise<readonly TranscriptEvent[]> {
    this.calls.push({ sessionId: target.sessionId, harness: target.harness, limit });
    return this.events;
  }
}

const user = (text: string, timestamp?: string): TranscriptEvent => ({
  kind: 'message',
  role: 'user',
  harness: 'claude',
  text,
  ...(timestamp === undefined ? {} : { timestamp }),
});

const assistant = (text: string): TranscriptEvent => ({ kind: 'message', role: 'assistant', harness: 'claude', text });

function lessonSessions(
  views: readonly SessionView[],
  events: readonly TranscriptEvent[],
): { readonly port: DirectoryLessonSessions; readonly transcripts: FakeTranscripts } {
  const transcripts = new FakeTranscripts(events);
  return {
    port: new DirectoryLessonSessions(new FakeDirectory(views), transcripts as unknown as SessionTranscriptReader),
    transcripts,
  };
}

const roots = new Set<string>();

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-lesson-files-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('lessonSessionFacts', () => {
  it('should read a running claude session without a transcript, teammate or label', () => {
    // Act
    const facts = lessonSessionFacts(session());

    // Assert
    should(facts).deepEqual({
      sessionId: 'session-1',
      cwd: '/repo',
      harness: 'claude',
      mode: 'interactive',
      createdAt: CREATED,
      running: true,
      hasTranscript: false,
    });
  });

  it('should read a finished codex teammate session with a label and a transcript', () => {
    // Act
    const facts = lessonSessionFacts(
      session({ harness: 'codex', teammate: 'ada', label: 'batch', status: 'completed', transcript: true }),
    );

    // Assert
    should(facts).deepEqual({
      sessionId: 'session-1',
      cwd: '/repo',
      harness: 'codex',
      mode: 'interactive',
      teammate: 'ada',
      label: 'batch',
      createdAt: CREATED,
      running: false,
      hasTranscript: true,
    });
  });

  it('should treat every terminal status as not running', () => {
    // Act
    const running = (['completed', 'failed', 'stalled', 'stopped'] as const).map(
      status => lessonSessionFacts(session({ status })).running,
    );

    // Assert
    should(running).deepEqual([false, false, false, false]);
  });
});

describe('DirectoryLessonSessions', () => {
  it('should answer facts for a known session and nothing for an unknown one', async () => {
    // Arrange
    const { port } = lessonSessions([session()], []);

    // Act
    const known = await port.facts('session-1');
    const unknown = await port.facts('missing');

    // Assert
    should(known?.sessionId).equal('session-1');
    should(unknown).be.undefined();
  });

  it('should list every session as facts', async () => {
    // Arrange
    const { port } = lessonSessions([session(), session({ id: 'session-2', status: 'stopped' })], []);

    // Act
    const listed = await port.list();

    // Assert
    should(listed.map(item => [item.sessionId, item.running])).deepEqual([
      ['session-1', true],
      ['session-2', false],
    ]);
  });

  it('should answer nothing for the owner message of an unknown session without reading a transcript', async () => {
    // Arrange
    const { port, transcripts } = lessonSessions([], [user('hi')]);

    // Act
    const message = await port.latestOwnerMessage('missing');

    // Assert
    should(message).be.undefined();
    should(transcripts.calls).deepEqual([]);
  });

  it('should answer nothing when the transcript holds no user turn', async () => {
    // Arrange
    const { port } = lessonSessions([session()], [assistant('Done.')]);

    // Act
    const message = await port.latestOwnerMessage('session-1');

    // Assert
    should(message).be.undefined();
  });

  it('should answer nothing when the last user turn is blank', async () => {
    // Arrange
    const { port } = lessonSessions([session()], [user('Use direnv.'), user('   ')]);

    // Act
    const message = await port.latestOwnerMessage('session-1');

    // Assert
    should(message).be.undefined();
  });

  it('should answer the last user turn with its own timestamp and the count of user turns', async () => {
    // Arrange
    const { port, transcripts } = lessonSessions(
      [session()],
      [user('First.', '2026-10-01T01:00:00.000Z'), assistant('Ok.'), user('Second.', '2026-10-01T02:00:00.000Z')],
    );

    // Act
    const message = await port.latestOwnerMessage('session-1');

    // Assert
    should(message).deepEqual({ text: 'Second.', at: '2026-10-01T02:00:00.000Z', turn: 2 });
    should(transcripts.calls).deepEqual([{ sessionId: 'session-1', harness: 'claude', limit: 1_200 }]);
  });

  it("should skip the harness's own events: neither the last owner message nor a turn", async () => {
    // Arrange — a background task finished after the owner spoke; Claude Code wrote it as a user record.
    const notification: TranscriptEvent = {
      ...user('<task-notification>\n<status>completed</status>\n</task-notification>', '2026-10-01T03:00:00.000Z'),
      inputSource: 'harness',
    };
    const { port } = lessonSessions([session()], [user('First.', '2026-10-01T01:00:00.000Z'), notification]);

    // Act
    const message = await port.latestOwnerMessage('session-1');

    // Assert
    should(message).deepEqual({ text: 'First.', at: '2026-10-01T01:00:00.000Z', turn: 1 });
  });

  it('should fall back to the session update time and read a codex transcript as codex', async () => {
    // Arrange
    const { port, transcripts } = lessonSessions([session({ harness: 'codex' })], [user('Untimed.')]);

    // Act
    const message = await port.latestOwnerMessage('session-1');

    // Assert
    should(message).deepEqual({ text: 'Untimed.', at: UPDATED, turn: 1 });
    should(transcripts.calls[0]?.harness).equal('codex');
  });
});

describe('NodeLessonFiles', () => {
  it('should find the nearest ancestor holding .git as the project root', async () => {
    // Arrange
    const root = await temporary();
    const nested = join(root, 'repo', 'packages', 'one');
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });

    // Act
    const found = await new NodeLessonFiles().projectRoot(nested);

    // Assert
    should(found).equal(join(root, 'repo'));
  });

  it('should answer the directory itself when no ancestor up to the filesystem root holds .git', async () => {
    // Arrange: the temporary directory sits outside every repository on this machine.
    const root = await temporary();
    const nested = join(root, 'loose', 'deeper');
    await mkdir(nested, { recursive: true });

    // Act
    const found = await new NodeLessonFiles().projectRoot(nested);

    // Assert
    should(found).equal(nested);
  });

  it('should answer nothing for a missing file', async () => {
    // Arrange
    const root = await temporary();

    // Act
    const text = await new NodeLessonFiles().read(join(root, 'AGENTS.md'));

    // Assert
    should(text).be.undefined();
  });

  it('should write through missing parents atomically and leave no temporary file behind', async () => {
    // Arrange
    const root = await temporary();
    const files = new NodeLessonFiles();
    const path = files.join(join(root, 'a', 'b'), 'AGENTS.md');

    // Act
    await files.write(path, '# Rules\n');
    await files.write(path, '# Rules v2\n');

    // Assert
    should(path).equal(join(root, 'a', 'b', 'AGENTS.md'));
    should(await files.read(path)).equal('# Rules v2\n');
    should(await readFile(path, 'utf8')).equal('# Rules v2\n');
    should(await readdir(join(root, 'a', 'b'))).deepEqual(['AGENTS.md']);
  });
});

const ASSETS = '/fleet/assets';
const HOME = '/home/owner';

function fleetModel(lessonsFile: string | undefined, profiles: Record<string, readonly string[]> = {}): AccountModel {
  return parseAccountModel({
    version: 2,
    credentials: { work: { harness: 'claude' } },
    components: {
      instructions: {
        main: { file: 'main.md' },
        ...(lessonsFile === undefined ? {} : { lessons: { file: lessonsFile } }),
      },
    },
    profiles: Object.fromEntries(Object.entries(profiles).map(([name, layers]) => [name, { layers }])),
  });
}

class FakeFleet implements FleetConfigAccess {
  readonly assetsDirectory = ASSETS;
  readonly userHome = HOME;
  readonly written: string[] = [];

  constructor(private readonly current: AccountModel) {}

  model(): AccountModel {
    return this.current;
  }

  async writeComponent(file: string): Promise<void> {
    this.written.push(file);
  }
}

describe('FleetGlobalLessons', () => {
  it('should locate the default file and say Apply creates the component when it is absent', async () => {
    // Arrange
    const lessons = new FleetGlobalLessons(new FakeFleet(fleetModel(undefined)));

    // Act
    const located = await lessons.locate();

    // Assert
    should(located).deepEqual({
      path: join(ASSETS, 'instructions/lessons.md'),
      notes: [
        'Applying creates the instructions component "lessons" for this file.',
        'No profile includes instructions/lessons yet, so no ferret reads it: add it to a profile.',
      ],
    });
  });

  it('should resolve a relative component file under the assets and name the one profile reading it', async () => {
    // Arrange
    const lessons = new FleetGlobalLessons(
      new FakeFleet(fleetModel('notes/lessons.md', { base: ['instructions/lessons'], other: ['instructions/main'] })),
    );

    // Act
    const located = await lessons.locate();

    // Assert
    should(located).deepEqual({
      path: join(ASSETS, 'notes/lessons.md'),
      notes: ['Read by ferrets on the profile base.'],
    });
  });

  it('should expand a home-relative file under the user home and name every profile reading it', async () => {
    // Arrange
    const lessons = new FleetGlobalLessons(
      new FakeFleet(fleetModel('~/x.md', { base: ['instructions/lessons'], top: ['instructions/lessons'] })),
    );

    // Act
    const located = await lessons.locate();

    // Assert
    should(located).deepEqual({ path: join(HOME, 'x.md'), notes: ['Read by ferrets on the profiles base, top.'] });
  });

  it('should keep an absolute file as written', async () => {
    // Arrange
    const lessons = new FleetGlobalLessons(new FakeFleet(fleetModel('/abs.md')));

    // Act
    const located = await lessons.locate();

    // Assert
    should(located.path).equal('/abs.md');
    should(located.notes).deepEqual([
      'No profile includes instructions/lessons yet, so no ferret reads it: add it to a profile.',
    ]);
  });

  it('should write the component only when it is missing', async () => {
    // Arrange
    const missing = new FakeFleet(fleetModel(undefined));
    const present = new FakeFleet(fleetModel('notes/lessons.md'));

    // Act
    await new FleetGlobalLessons(missing).ensureComponent();
    await new FleetGlobalLessons(present).ensureComponent();

    // Assert
    should(missing.written).deepEqual(['instructions/lessons.md']);
    should(present.written).deepEqual([]);
  });
});

describe('SessionPassiveChannel', () => {
  function channel(): {
    readonly port: SessionPassiveChannel;
    readonly merged: [string, Readonly<Record<string, string>>][];
    readonly sent: [string, string, string][];
  } {
    const merged: [string, Readonly<Record<string, string>>][] = [];
    const sent: [string, string, string][] = [];
    return {
      merged,
      sent,
      port: new SessionPassiveChannel({
        variable: 'FY_LEARNING_PASSIVE',
        mergeEnvironment: async (sessionId, variables) => {
          merged.push([sessionId, variables]);
        },
        send: async (sessionId, message, sendId) => {
          sent.push([sessionId, message, sendId]);
        },
      }),
    };
  }

  it('should set the variable to 1 when passive and 0 when not', async () => {
    // Arrange
    const { port, merged } = channel();

    // Act
    await port.setEnvironment('session-1', true);
    await port.setEnvironment('session-1', false);

    // Assert
    should(merged).deepEqual([
      ['session-1', { FY_LEARNING_PASSIVE: '1' }],
      ['session-1', { FY_LEARNING_PASSIVE: '0' }],
    ]);
  });

  it('should send a reinstruction under a fresh learning send id and answer that id', async () => {
    // Arrange
    const { port, sent } = channel();

    // Act
    const id = await port.reinstruct('session-1', 'Stop noting lessons.');

    // Assert
    should(id).match(/^learning-[0-9a-f-]{36}$/);
    should(sent).deepEqual([['session-1', 'Stop noting lessons.', id]]);
  });
});

describe('CatalogPrices', () => {
  const rate: AnalyticsPricingRate = {
    pricingKey: 'anthropic:model-a@2026-07-01',
    modelId: 'model-a',
    aliases: [],
    provider: 'anthropic',
    currency: 'USD',
    rates: {
      input: 2_000_000,
      output: 10_000_000,
      cachedInput: 200_000,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      reasoning: null,
      image: null,
      tool: null,
    },
    source: { kind: 'manual' },
    verifiedAt: '2026-07-01T00:00:00Z',
    validFrom: '2026-07-01T00:00:00Z',
    validThrough: null,
    lastSyncedAt: null,
  };
  const now = (): string => '2026-10-16T00:00:00.000Z';

  it('should price a known model in dollars', async () => {
    // Arrange
    const prices = new CatalogPrices(async () => [rate], now);

    // Act
    const usd = await prices.usd('model-a', 1_000_000, 1_000_000);

    // Assert
    should(usd).equal(12);
  });

  it('should answer nothing for a model the catalog does not price', async () => {
    // Arrange
    const prices = new CatalogPrices(async () => [rate], now);

    // Act
    const usd = await prices.usd('model-z', 1_000, 1_000);

    // Assert
    should(usd).be.undefined();
  });

  it('should answer nothing when the catalog cannot be read', async () => {
    // Arrange
    const prices = new CatalogPrices(async () => await Promise.reject(new Error('catalog unavailable')), now);

    // Act
    const usd = await prices.usd('model-a', 1_000, 1_000);

    // Assert
    should(usd).be.undefined();
  });
});
