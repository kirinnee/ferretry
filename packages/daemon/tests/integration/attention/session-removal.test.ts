import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionConfigSchema, SessionStateSchema } from '@ferretry/protocol';
import should from 'should';
import { FileAttentionLedgerRepository } from '../../../src/adapters/attention/file-attention-ledger-repository.ts';
import {
  BunSqliteIndexFactory,
  type DaemonStorage,
  DaemonStorageFactory,
  KeyedSerialExecutor,
  type OpenedDaemonStorage,
  RuntimeEnvironment,
  SqliteHomeLockFactory,
  StateFileSystemFactory,
  StateHomeLayout,
  StorageConsistencyPass,
  SystemClock,
} from '../../../src/adapters/index.ts';
import {
  type AttentionActor,
  AttentionService,
  createSessionPaths,
  defaultSessionHealthSettings,
  type FoundationPaths,
  parseSessionId,
  tryParseSessionId,
  WARDEN_ESCALATION_SOURCE,
  wardenEscalationSourceRef,
} from '../../../src/lib/index.ts';

/**
 * What a session leaving the registry does to the Attention board it owned.
 *
 * PRODUCTION WIRING, NOT A PLANNER FIXTURE. `lib/warden/escalation.ts` can clear a board whose node
 * has left, and nothing in this daemon can hand it one — the sweep reads boards only for sessions the
 * fleet reader still returns. The claim was that removal clears the escalation; what actually happens
 * is decided by two facts these cases pin, over the real store, the real ledger file and the same
 * service composition `bin/fyd.ts` builds:
 *
 *   1. Removal is an OBSERVATION. There is no delete route; the index drops a row only after the
 *      session directory or its marker is already gone or refused, which the health tick notices
 *      through `StorageConsistencyPass` and `DaemonStorage.reconcile`.
 *   2. The ledger lives INSIDE the session directory, so a directory deleted outside this daemon
 *      takes the board and its resolution audit with it. Nothing is claimed resolved, and no
 *      retained history is reconstructed.
 */

const SESSION = 'ferretry-removal-1';
const AT = '2026-07-30T12:00:00.000Z';

/** The trusted actor `bin/fyd.ts` gives the warden's own raises and clears. */
const WARDEN: AttentionActor = { kind: 'daemon', cause: 'warden-escalation' };

const ESCALATION = {
  source: WARDEN_ESCALATION_SOURCE,
  sourceRef: wardenEscalationSourceRef('unattended_question'),
  subject: 'Ada needs a human — an unanswered question',
  why: 'Answering could commit work nobody has reviewed.',
  howToResolve: 'Open the session and answer it.',
} as const;

const homes: string[] = [];
const stores: DaemonStorage[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async storage => await storage.close().catch(() => undefined)));
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

async function openStorage(): Promise<OpenedDaemonStorage> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-removal-'));
  homes.push(home);
  const factory = new DaemonStorageFactory(
    new RuntimeEnvironment({ FY_HOME: home }, () => '/home-must-not-be-used'),
    new StateFileSystemFactory(),
    new StateHomeLayout(),
    new SqliteHomeLockFactory(),
    new BunSqliteIndexFactory(),
    new SystemClock(() => new Date(AT)),
    () => new KeyedSerialExecutor(),
  );
  const opened = await factory.open();
  stores.push(opened.storage);
  return opened;
}

/**
 * The attention service exactly as `bin/fyd.ts` composes it: one ledger repository under the session
 * directory, and a directory proof that answers from the session index.
 *
 * The proof is what makes these cases meaningful — it is `undefined` for a session the index does not
 * hold and THROWS for one whose documents do not satisfy the protocol, so an unusable session fails
 * closed rather than reading as an empty board.
 */
function attentionFor(opened: OpenedDaemonStorage): AttentionService {
  return new AttentionService(
    new FileAttentionLedgerRepository(id => createSessionPaths(opened.paths, parseSessionId(id)).directory),
    { now: () => AT },
    {
      has: async id => {
        const parsed = tryParseSessionId(id);
        if (parsed === undefined || opened.storage.findSession(parsed) === undefined) return false;
        const config = SessionConfigSchema.safeParse(await opened.storage.readConfig(parsed));
        const state = SessionStateSchema.safeParse(await opened.storage.readState(parsed));
        if (!config.success || !state.success) throw new Error(`session ${id} does not satisfy the protocol`);
        return true;
      },
    },
  );
}

async function seedSession(storage: DaemonStorage, sessionId: string = SESSION): Promise<void> {
  const id = parseSessionId(sessionId);
  await storage.writeConfig(
    id,
    SessionConfigSchema.parse({
      id: sessionId,
      incarnation: `${sessionId}-1`,
      runtimeGeneration: 1,
      name: 'Removal Journey',
      teammate: 'Ada',
      boardAccess: 'none',
      agent: 'claude-auto',
      harness: 'claude',
      modelHint: 'opus',
      mode: 'auto',
      remoteControl: false,
      harnessFlags: [],
      cwd: '/home/dev/repo',
      createdAt: AT,
      updatedAt: AT,
      turn: 1,
      intervalSeconds: 30,
      timeoutSeconds: 0,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 0,
      directSendMaxChars: 4_096,
      resumeMenuChoice: 'full',
      maxSnapshots: 10,
      retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
    }),
  );
  await storage.writeState(
    id,
    SessionStateSchema.parse({ id: sessionId, status: 'running', turn: 1, lastActivityAt: AT }),
  );
}

/** The removal pass the health tick actually runs, not a direct reconcile. */
function consistencyPass(opened: OpenedDaemonStorage): StorageConsistencyPass {
  return new StorageConsistencyPass(opened.storage, opened.fileSystem, opened.paths, defaultSessionHealthSettings);
}

function ledgerFile(paths: FoundationPaths, sessionId: string = SESSION): string {
  return join(createSessionPaths(paths, parseSessionId(sessionId)).directory, 'attention.json');
}

async function ledgerText(paths: FoundationPaths, sessionId: string = SESSION): Promise<string | undefined> {
  return await readFile(ledgerFile(paths, sessionId), 'utf8').catch(() => undefined);
}

describe('a warden escalation when its session leaves the registry', () => {
  it('should retain the disposition and the note while the session is still there', async () => {
    // Arrange
    const opened = await openStorage();
    await seedSession(opened.storage);
    const attention = attentionFor(opened);
    await attention.raise(SESSION, ESCALATION, WARDEN);

    // Act — the sweep's own clear, through the one service every other caller uses.
    const note = 'Cleared by the daemon: the node recovered — unattended_question is no longer detected.';
    const cleared = await attention.resolveSource(SESSION, ESCALATION.source, ESCALATION.sourceRef, WARDEN, note);
    const listed = await attention.list(SESSION);

    // Assert — this is the audit the product genuinely keeps: nothing active, and the disposition,
    // the actor and the note all durable in retained history.
    should(cleared).containDeep({ ok: true, changed: true, change: 'resolved' });
    should(listed).containDeep({
      ok: true,
      value: {
        count: 0,
        items: [],
        resolved: [
          {
            sourceRef: ESCALATION.sourceRef,
            disposition: 'done',
            resolvedBy: 'daemon',
            resolutionNote: note,
          },
        ],
      },
    });
  });

  it('should lose the board with the directory rather than invent a resolution for it', async () => {
    // Arrange — a live escalation, on disk, under a session the index holds.
    const opened = await openStorage();
    await seedSession(opened.storage);
    const attention = attentionFor(opened);
    await attention.raise(SESSION, ESCALATION, WARDEN);
    should(await ledgerText(opened.paths)).containEql(ESCALATION.sourceRef);

    // Act — the session directory is deleted outside this daemon, and the health tick's pass is
    // the first thing that can notice.
    await rm(createSessionPaths(opened.paths, parseSessionId(SESSION)).directory, { recursive: true, force: true });
    const pass = await consistencyPass(opened).run(true);

    // Assert — the row is reported as stale and forgotten, the ledger went with the directory, and
    // the board is no longer addressable. There is no resolution anywhere, invented or otherwise.
    should(pass.staleRows).containEql(SESSION);
    should(opened.storage.findSession(parseSessionId(SESSION))).be.undefined();
    should(await ledgerText(opened.paths)).be.undefined();
    should(await attention.list(SESSION)).containDeep({ ok: false, error: { code: 'not-found' } });
  });

  it('should keep a quarantined board durable and unaddressable rather than falsely resolved', async () => {
    // Arrange
    const opened = await openStorage();
    await seedSession(opened.storage);
    const attention = attentionFor(opened);
    await attention.raise(SESSION, ESCALATION, WARDEN);

    // Act — the marker is refused rather than absent, so the directory survives the removal.
    await writeFile(createSessionPaths(opened.paths, parseSessionId(SESSION)).marker, '3\n');
    const pass = await consistencyPass(opened).run(true);

    // Assert — the index drops it and the pass says so, but the ledger is untouched and its row is
    // still ACTIVE. Clearing it would claim a session whose layout cannot be read no longer needs a
    // human, which is the one thing that must never be written into the audit.
    //
    // WHICH FIELD REPORTS IT IS PINNED IN BOTH DIRECTIONS, because the obvious guess is wrong and a
    // reader who assumes `unhealable` would believe this session escalates to a self-restart.
    // `surveySessionDirectories` skips a refused marker, so the directory is absent from the
    // post-repair on-disk set that `unhealable` is filtered from, and the session can only ever
    // surface as a stale row. Both are folded into the same `fleet.index_incoherent` event, so it is
    // still reported — under the honest name.
    should(pass.staleRows).containEql(SESSION);
    should(pass.unhealable).be.empty();
    should(opened.storage.findSession(parseSessionId(SESSION))).be.undefined();
    const durable = await ledgerText(opened.paths);
    should(durable).containEql(ESCALATION.sourceRef);
    should(JSON.parse(durable ?? '{}')).containDeep({ entries: [{ lifecycle: 'active' }] });
    should(await attention.list(SESSION)).containDeep({ ok: false, error: { code: 'not-found' } });
  });
});
