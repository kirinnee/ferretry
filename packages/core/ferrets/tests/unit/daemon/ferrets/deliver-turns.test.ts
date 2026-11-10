import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoot, type MemoryStateFolder } from '@ferretry/kernel/testing';
import { err, ok, type Result } from '@ferretry/std';
import {
  FerretConfigFile,
  type FerretRecord,
  type OpeningAttachmentsSource,
  type RunnerHandle,
  type RunnerLook,
  type RunningFerret,
  type RunSpec,
  type StartRefusal,
} from '../../../../contract/index.ts';
import { emptyChildEnvironment, FakeHarness, FakeRunner, fenced, T0 } from '../../../../contract/testing/index.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { SessionFiles } from '../../../../daemon/modules/session-files.ts';
import { SessionConfigSchema, SessionStateSchema } from '../../../../daemon/lib/protocol/session.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { queuedMessageInstruction, turnFileInstruction } from '../../../../daemon/lib/protocol/turn-handoff.ts';
import { defaultSessionResumeSettings } from '../../../../daemon/lib/session/resume/settings.ts';
import type { ResumeActor } from '../../../../daemon/lib/session/resume/types.ts';
import { memoryStorage } from '../../../support/daemon/storage.ts';

/**
 * The deliver seam (U3) end to end on the service: the start's assigned task, a revive's numbered turn and its markers,
 * the pointer typed into the new pane, `turns()` and the session document the start now writes (ruling #31b). The
 * session store is the real one over a memory state folder; the ferret folders are real ones on the internal
 * `sessions` root of a temporary home. Fixture values only.
 */

const NOW = '2026-11-08T10:00:00.000Z';
const IDS = ['mw7bp88g-00000001', 'mw7bp88g-00000002', 'mw7bp88g-00000003', 'mw7bp88g-00000004'] as const;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** A runner whose next starts can be refused, and that tells a test what it saw at the moment of each start. */
class ScriptedRunner extends FakeRunner {
  refuseStarts = 0;
  /** Today's startup wait, when a test gives the runner one; absent, a start does not wait (as a runner that cannot tell). */
  settled?: (handle: RunnerHandle) => Promise<'settled' | 'timed-out'>;
  /** What the pane last showed, when a test gives the runner a screen to read. */
  lastScreen?: (handle: RunnerHandle) => Promise<string>;
  readonly stopped: string[] = [];
  override async stop(handle: RunnerHandle): Promise<void> {
    this.stopped.push(handle);
    await super.stop(handle);
  }
  onStart: ((spec: RunSpec) => Promise<void>) | undefined;
  override async start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    await this.onStart?.(spec);
    if (this.refuseStarts > 0) {
      this.refuseStarts -= 1;
      return err('failed');
    }
    return await super.start(spec);
  }
}

interface World {
  readonly service: FerretsService;
  readonly registry: FerretRegistry;
  readonly files: SessionFiles;
  readonly runner: ScriptedRunner;
  readonly harness: FakeHarness;
  readonly tokens: FerretTokenDirectory;
  readonly storage: Awaited<ReturnType<typeof memoryStorage>>['storage'];
  readonly state: MemoryStateFolder;
  readonly folderOf: (id: string) => string;
  readonly warnings: string[];
}

/** One daemon over ferret folders that outlive it: `restart` builds the next one on the same state and disk. */
async function world(
  records: readonly FerretRecord[] = [],
  reuse?: {
    readonly state: MemoryStateFolder;
    readonly handles: Readonly<Record<string, RootHandle>>;
    readonly folders: Readonly<Record<string, string>>;
  },
  backfill = true,
  openingSource?: OpeningAttachmentsSource,
): Promise<World & { readonly reuse: NonNullable<typeof reuse> }> {
  let handles = reuse?.handles;
  let folders = reuse?.folders;
  if (handles === undefined || folders === undefined) {
    const parent = await mkdtemp(`${tmpdir()}/fy-deliver-`);
    parents.push(parent);
    const made: Record<string, RootHandle> = {};
    const where: Record<string, string> = {};
    for (const id of IDS) {
      const disk = await diskSessionsRoot(parent, id);
      made[id] = disk.root;
      where[id] = disk.folder;
    }
    handles = made;
    folders = where;
  }
  const { storage, folder: state } = await memoryStorage({
    clock: { now: () => NOW },
    ...(reuse === undefined ? {} : { folder: reuse.state }),
  });
  const registry = new FerretRegistry(records);
  const warnings: string[] = [];
  const files = new SessionFiles({
    roots: {
      root: (_name, scope) => {
        const handle = handles[scope?.subfolder ?? ''];
        if (handle === undefined) throw new Error(`no fixture folder for ${scope?.subfolder ?? ''}`);
        return handle;
      },
    },
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () =>
      registry
        .list()
        .map(ferret => ({ id: ferret.id, ...(ferret.parent === undefined ? {} : { parent: ferret.parent }) })),
    seed: id => {
      const record = registry.get(id as never);
      return record === undefined ? undefined : { record, details: registry.detailsOf(record.id) };
    },
    log: { warn: message => void warnings.push(message) },
  });
  const runner = new ScriptedRunner();
  const harness = new FakeHarness();
  let next = records.length;
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      const id = IDS[next];
      next += 1;
      if (id === undefined) throw new Error('the fixture has no more ferret folders');
      return id as never;
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: () => harness,
    harnessKeys: () => [harness.key],
    runner: () => runner,
    // Packs' admission stands in here: this fixture lets a helper start, so the stamp's ancestry is what decides.
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    openingAttachments: () => openingSource,
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
    asks: { open: async () => [] },
    session: files.port,
  };
  const tokens = new FerretTokenDirectory();
  const service = new FerretsService(registry, tokens, ports);
  if (backfill) await files.backfill(async () => registry.list().map(ferret => ferret.id));
  return {
    service,
    registry,
    files,
    runner,
    harness,
    tokens,
    storage,
    state,
    folderOf: id => folders[id] ?? '',
    warnings,
    reuse: { state, handles, folders },
  };
}

const turnFile = (w: World, id: string, turn: number) =>
  `${w.folderOf(id)}/turns/turn-${String(turn).padStart(3, '0')}.md`;

async function started(w: World, prompt?: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await w.service.start({
    folder: '/work',
    by: 'owner',
    ...(prompt === undefined ? {} : { prompt }),
    ...extra,
  });
  if (!result.ok) throw new Error(`start refused: ${result.error.reason}`);
  return result.value;
}

const revive = async (w: World, id: string, message?: string, actor?: ResumeActor) =>
  await w.service.resume(id as never, message, actor === undefined ? undefined : { actor });

describe('GAP(deliver) a revive writes the numbered turn, clears the markers and types its pointer', () => {
  test('GAP(deliver) a revive writes its turn and counts it BEFORE the relaunch, so a failed relaunch keeps its document and the retry takes the next number', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    // The start's prompt is the assigned task: turn one, so the first revive is turn two.
    expect(await readFile(turnFile(w, id, 1), 'utf8')).toBe('# Assigned task\n\nBuild the thing.\n');
    await w.service.stop(id as never, 'now');
    const typed = w.runner.deliveries.length;

    // Today's order: write the turn, clear the markers, save the counter, relaunch. A relaunch that fails leaves the
    // document on disk, counted, as the evidence of what the agent was about to be handed.
    w.runner.refuseStarts = 1;
    expect((await revive(w, id, 'Carry on with the tests.')).ok).toBe(false);
    expect(w.runner.deliveries).toHaveLength(typed);
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id))).turn).toBe(2);

    // The retry is a NEW attempt with a new number; the failed attempt's document is never rewritten.
    const kept = await stat(turnFile(w, id, 2));
    expect((await revive(w, id, 'Carry on with the tests.')).ok).toBe(true);
    expect((await stat(turnFile(w, id, 2))).ino).toBe(kept.ino);
    expect(await readFile(turnFile(w, id, 3), 'utf8')).toBe(
      `Carry on with the tests.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    );
    expect(w.runner.deliveries.slice(typed).map(delivery => delivery.delivery.text)).toEqual([
      turnFileInstruction(turnFile(w, id, 3)),
    ]);
    // Typed into the NEW pane.
    expect(w.runner.deliveries.at(-1)?.handle).toBe(w.registry.get(id as never)?.handle as never);
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id))).turn).toBe(3);

    // The next revive numbers after it, and an auto ferret with no message is given the default prompt.
    await w.service.stop(id as never, 'now');
    expect((await revive(w, id)).ok).toBe(true);
    expect(await readFile(turnFile(w, id, 4), 'utf8')).toBe(
      `${defaultSessionResumeSettings.defaultResumePrompt}\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    );
  });

  test('GAP(deliver) a revive writes turn-NNN.md once: a turn written but never counted is handed over again only as an exact replay, proved in place', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const starts = w.runner.starts;
    // The counter cannot be saved once: the relaunch is refused before any pane, the document stays uncounted.
    const update = w.storage.updateState.bind(w.storage);
    let failures = 1;
    w.storage.updateState = async (...args) => {
      if (failures-- > 0) throw new Error('FIXTURE_SECRET state refused');
      return await update(...args);
    };
    const refused = await revive(w, id, 'Carry on with the tests.', 'admin-ui');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).not.toContain('FIXTURE_SECRET');
    expect(w.runner.starts).toBe(starts);
    const written = await stat(turnFile(w, id, 2));

    // The same words from the same author: the SAME number and file, not rewritten.
    expect((await revive(w, id, 'Carry on with the tests.', 'admin-ui')).ok).toBe(true);
    expect((await stat(turnFile(w, id, 2))).ino).toBe(written.ino);
    expect(w.runner.deliveries.at(-1)?.delivery.text).toBe(turnFileInstruction(turnFile(w, id, 2)));
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id))).turn).toBe(2);
  });

  test('GAP(deliver) M1 P1: a later revive with other words and no author never rewrites the owner’s undelivered turn or takes its author', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    // The owner resumes with "Do X." and the relaunch fails.
    w.runner.refuseStarts = 1;
    expect((await revive(w, id, 'Do X.', 'admin-ui')).ok).toBe(false);

    // Then an automatic revive with no message and no actor (the Warden's in-process path before it named itself).
    expect((await revive(w, id)).ok).toBe(true);

    const turns = await w.files.port.turns?.(id as never, { strict: true });
    expect(turns?.map(turn => turn.turn)).toEqual([1, 2, 3]);
    // The owner's words stay theirs, and Ferretry's default prompt is never drawn as the owner's.
    expect(turns?.[1]).toEqual({
      turn: 2,
      text: `Do X.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
      by: { kind: 'owner' },
    });
    expect(turns?.[2]).toEqual({
      turn: 3,
      text: `${defaultSessionResumeSettings.defaultResumePrompt}\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    });
  });

  test('GAP(deliver) M1 P1: other words after an uncounted turn take the next number, never the uncounted one', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const update = w.storage.updateState.bind(w.storage);
    let failures = 1;
    w.storage.updateState = async (...args) => {
      if (failures-- > 0) throw new Error('state refused');
      return await update(...args);
    };
    expect((await revive(w, id, 'Do X.', 'admin-ui')).ok).toBe(false);

    expect((await revive(w, id, 'Something else.')).ok).toBe(true);

    const turns = await w.files.port.turns?.(id as never, { strict: true });
    expect(turns?.[1]).toEqual({
      turn: 2,
      text: `Do X.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
      by: { kind: 'owner' },
    });
    expect(turns?.[2]).toEqual({
      turn: 3,
      text: `Something else.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    });
  });

  test('GAP(deliver) M1 P2: a turn whose pointer was typed is never rewritten by the next revive, and the pane is told each file once', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const typed = w.runner.deliveries.length;
    expect((await revive(w, id, 'First revive words.')).ok).toBe(true);
    await w.service.stop(id as never, 'now');

    expect((await revive(w, id, 'Second revive words.')).ok).toBe(true);

    expect(await readFile(turnFile(w, id, 2), 'utf8')).toBe(
      `First revive words.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    );
    expect(await readFile(turnFile(w, id, 3), 'utf8')).toBe(
      `Second revive words.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    );
    expect(w.runner.deliveries.slice(typed).map(delivery => delivery.delivery.text)).toEqual([
      turnFileInstruction(turnFile(w, id, 2)),
      turnFileInstruction(turnFile(w, id, 3)),
    ]);
  });

  test('GAP(deliver) an author record a crash left at a fresh number is removed before a turn with no author is written there', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    // The author lands first, so a crash between the two leaves a record with no document beside it.
    await mkdir(`${w.folderOf(id)}/turns`, { recursive: true });
    await writeFile(turnFile(w, id, 2).replace(/\.md$/u, '.by.json'), '{"kind":"owner"}\n');

    expect((await revive(w, id, 'Again.')).ok).toBe(true);

    await expect(stat(turnFile(w, id, 2).replace(/\.md$/u, '.by.json'))).rejects.toThrow();
    expect((await w.files.port.turns?.(id as never, { strict: true }))?.[1]).toEqual({
      turn: 2,
      text: `Again.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`,
    });
  });

  test('GAP(deliver) markers are cleared before relaunch, and the new turn is on disk when the pane starts', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    for (const marker of ['done', 'needs-help', 'process-exit'])
      await writeFile(`${w.folderOf(id)}/${marker}.marker`, `${marker}\n`);
    const seen: string[] = [];
    w.runner.onStart = async () => {
      for (const marker of ['done', 'needs-help', 'process-exit'])
        seen.push(
          `${marker} ${await stat(`${w.folderOf(id)}/${marker}.marker`).then(
            () => 'still there',
            () => 'gone',
          )}`,
        );
      seen.push(
        `turn-002 ${await stat(turnFile(w, id, 2)).then(
          () => 'written',
          () => 'missing',
        )}`,
      );
    };

    expect((await revive(w, id, 'Again.')).ok).toBe(true);

    expect(seen).toEqual(['done gone', 'needs-help gone', 'process-exit gone', 'turn-002 written']);
  });

  test('GAP(deliver) a turn that cannot be written refuses the relaunch before any pane exists, quoting nothing', async () => {
    const w = await world();
    const id = await started(w);
    await w.service.stop(id as never, 'now');
    const starts = w.runner.starts;
    // A folder where the turn document must go makes the write fail.
    await writeFile(`${w.folderOf(id)}/turns`, 'FIXTURE_SECRET in the way\n');

    const resumed = await revive(w, id, 'Again.');

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.error.reason).toBe('a new turn could not be written for this ferret, so it was not relaunched');
      expect(resumed.error.reason).not.toContain('FIXTURE_SECRET');
    }
    expect(w.runner.starts).toBe(starts);
  });

  test('GAP(deliver) an interactive ferret resumed with no message is relaunched with no invented turn, its markers cleared', async () => {
    const w = await world();
    const id = await started(w, undefined, { options: { mode: 'interactive' } });
    await w.service.stop(id as never, 'now');
    await writeFile(`${w.folderOf(id)}/done.marker`, 'done\n');

    expect((await revive(w, id)).ok).toBe(true);

    expect(await w.files.port.turns?.(id as never, { strict: true })).toEqual([]);
    expect(w.runner.deliveries).toEqual([]);
    await expect(stat(`${w.folderOf(id)}/done.marker`)).rejects.toThrow();
  });

  for (const [actor, by] of [
    ['warden', { kind: 'ferretry', feature: 'Warden' }],
    ['daemon', { kind: 'ferretry', feature: 'Restart' }],
    ['admin-ui', { kind: 'owner' }],
    ['peer', { kind: 'ferret' }],
  ] as const)
    test(`F-0002 a revive asked by ${actor} records who the turn is from beside it, never in it`, async () => {
      const w = await world();
      const id = await started(w);
      await w.service.stop(id as never, 'now');

      expect((await revive(w, id, 'Again.', actor)).ok).toBe(true);

      expect(JSON.parse(await readFile(turnFile(w, id, 1).replace(/\.md$/u, '.by.json'), 'utf8'))).toEqual(by);
      expect(await readFile(turnFile(w, id, 1), 'utf8')).not.toContain(by.kind);
    });

  test('M2 F-0002 the Warden’s in-process resume, through the Ferrets port, writes a turn from the Warden; no other caller can name an author there', async () => {
    const w = await world();
    const id = await started(w);
    const port = ferretsPort(w.service, 'warden');
    await w.service.stop(id as never, 'now');

    expect((await port.resume(id as never, 'Carry on.', { automatic: true, actor: 'warden' })).ok).toBe(true);
    await w.service.stop(id as never, 'now');
    // Only `warden` and `peer` are forwarded: anything else a caller puts there names nobody.
    expect((await port.resume(id as never, 'Again.', { actor: 'admin-ui' } as never)).ok).toBe(true);
    await w.service.stop(id as never, 'now');
    expect((await port.resume(id as never, 'A peer woke it.', { actor: 'peer' })).ok).toBe(true);

    const turns = await w.files.port.turns?.(id as never, { strict: true });
    expect(turns?.map(turn => turn.by)).toEqual([
      { kind: 'ferretry', feature: 'Warden' },
      undefined,
      { kind: 'ferret' },
    ]);
  });

  test('GAP(deliver) a delivery that does not land says so, leaves the ferret running and its turn counted (today’s order)', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const deliver = w.runner.deliver.bind(w.runner);
    w.runner.deliver = async () => {
      throw new Error('FIXTURE_SECRET pane refused');
    };

    const resumed = await revive(w, id, 'Again.');

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.error.reason).not.toContain('FIXTURE_SECRET');
    expect(w.registry.get(id as never)?.state).toBe('working');
    // Counted before the relaunch: the next revive takes turn three, and turn two stays on disk as it was written.
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id))).turn).toBe(2);
    w.runner.deliver = deliver;
  });
});

describe('F-0344 today’s deliverFirstTurn: a start types its assigned task’s pointer once, under the effect ledger', () => {
  const firstTurn = (w: World, id: string) => turnFileInstruction(turnFile(w, id, 1));

  test('F-0344 a start with a prompt types the pointer to turns/turn-001.md into its new pane exactly once, and settles it', async () => {
    const w = await world();

    const id = await started(w, 'Build the thing.');

    expect(w.runner.deliveries.map(delivery => delivery.delivery.text)).toEqual([firstTurn(w, id)]);
    expect(w.runner.deliveries[0]?.handle).toBe(w.registry.get(id as never)?.handle as never);
    // Settled: the ledger now answers a replay of this start as one that must type nothing.
    expect(await w.files.port.admitFirstTurn?.(id as never, 'Build the thing.')).toBe('settled');
    // Not wrapped in an act of Ferrets' own: the runner acts per write itself, and Ferrets holds no act runner.
    expect(w.runner.deliveries).toHaveLength(1);
  });

  test('a start with no prompt has no first turn: nothing is typed and no turn document is written', async () => {
    const w = await world();

    const id = await started(w);

    expect(w.runner.deliveries).toEqual([]);
    expect(await w.files.port.turns?.(id as never, { strict: true })).toEqual([]);
  });

  test('F-0344 a settled first turn is a replay: the ledger is asked before the first key, and nothing is typed', async () => {
    const w = await world();
    const id = IDS[0];
    await w.files.port.prepare(id as never);
    expect(await w.files.port.admitFirstTurn?.(id as never, 'Build the thing.')).toBe('perform');
    await w.files.port.settleFirstTurn?.(id as never, 'Build the thing.');

    expect(await started(w, 'Build the thing.')).toBe(id);

    expect(w.runner.deliveries).toEqual([]);
    expect(w.registry.get(id as never)?.state).toBe('working');
  });

  for (const [standing, prepare, reason] of [
    [
      'conflict',
      async (w: World) => {
        await w.files.port.admitFirstTurn?.(IDS[0] as never, 'A different task.');
      },
      "the ferret's first-turn record is held for a different task, so it was not started",
    ],
    [
      'unsettled',
      async (w: World) => {
        await w.files.port.admitFirstTurn?.(IDS[0] as never, 'Build the thing.');
      },
      "the ferret's first turn began but never settled; it was not typed again, so the ferret was not started",
    ],
  ] as const)
    test(`F-0344 a first turn the ledger answers ${standing} is never typed, and the start fails with its pane stopped`, async () => {
      const w = await world();
      await w.files.port.prepare(IDS[0] as never);
      await prepare(w);

      const result = await w.service.start({ folder: '/work', by: 'owner', prompt: 'Build the thing.' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.reason).toBe(reason);
      expect(w.runner.deliveries).toEqual([]);
      expect(w.registry.get(IDS[0] as never)?.state).toBe('stopped');
      // The pane this start opened was stopped: no agent is left sitting at an idle prompt.
      expect(w.runner.starts).toBe(1);
      expect(await w.runner.alive('%1' as never)).toBe(false);
    });

  test('F-0344 a first turn that cannot be typed fails the start, stops its pane and quotes nothing', async () => {
    const w = await world();
    w.runner.deliver = async () => {
      throw new Error('FIXTURE_SECRET pane refused');
    };

    const result = await w.service.start({ folder: '/work', by: 'owner', prompt: 'Build the thing.' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(
        "the ferret's assigned task could not be typed into its pane, so it was not started",
      );
      expect(result.error.reason).not.toContain('FIXTURE_SECRET');
    }
    expect(await w.runner.alive('%1' as never)).toBe(false);
    expect(w.registry.get(IDS[0] as never)?.state).toBe('stopped');
  });
});

/**
 * Today's `settleStartup` (britnee's ruling: must-fix): delivery is not startup. Codex takes the first turn while it is
 * still starting and parks it until its account check answers, so a pane that dies in that window fails THIS start,
 * with the harness's own explanation when it has one (today's `RuntimeSupervisedLauncher`) and today's never-ran or
 * maybe-ran ending, instead of answering a working ferret whose task never ran. Fixture values only.
 */
describe('GAP(deliver) settleStartup: a pane that dies while its harness is still starting fails the start', () => {
  const NEVER_RAN = '; its first turn was never run, so start a new session rather than reviving this one';
  const MAYBE_RAN = '; its first turn may not have run, so start a new session rather than reviving this one';
  const died = (parked: boolean) => async (): Promise<'settled' | 'timed-out'> =>
    await Promise.reject(Object.assign(new Error('FIXTURE_SECRET the pane exited; tmux session fy-x'), { parked }));
  const live = (w: World, id: string) =>
    w.tokens.snapshot().filter(entry => entry.ferret === id && entry.revoked !== true);

  for (const [label, parked, ending] of [
    ['(a) parked: its first turn was never run', true, NEVER_RAN],
    ['(b) not seen parked: its first turn may not have run', false, MAYBE_RAN],
  ] as const)
    test(`GAP(deliver) settleStartup ${label}; the pane is stopped, the token revoked, nothing quoted`, async () => {
      const w = await world();
      w.runner.settled = died(parked);

      const result = await w.service.start({ folder: '/work', by: 'owner', prompt: 'Build the thing.' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('failed');
        expect(result.error.reason).toBe(`the ferret's pane exited while its harness was still starting${ending}`);
        expect(result.error.reason).not.toContain('FIXTURE_SECRET');
        expect(result.error.reason).not.toContain('fy-x');
      }
      // Typed once and settled, as today: a replay of this start would type nothing.
      expect(w.runner.deliveries).toHaveLength(1);
      expect(await w.files.port.admitFirstTurn?.(IDS[0] as never, 'Build the thing.')).toBe('settled');
      expect(w.runner.stopped).toEqual(['%1']);
      expect(await w.runner.alive('%1' as never)).toBe(false);
      expect(live(w, IDS[0])).toEqual([]);
      expect(w.registry.get(IDS[0] as never)?.state).toBe('stopped');
    });

  test('GAP(deliver) settleStartup (c) a wait that runs out its bound is not a failure: the start succeeds', async () => {
    const w = await world();
    const waited: string[] = [];
    w.runner.settled = async handle => {
      waited.push(handle);
      return 'timed-out';
    };

    const id = await started(w, 'Build the thing.');

    expect(waited).toEqual(['%1']);
    expect(w.registry.get(id as never)?.state).toBe('working');
    expect(w.runner.stopped).toEqual([]);
  });

  test('GAP(deliver) settleStartup (d) a runner with no startup wait starts as before', async () => {
    const w = await world();
    expect(w.runner.settled).toBeUndefined();

    const id = await started(w, 'Build the thing.');

    expect(w.registry.get(id as never)?.state).toBe('working');
    expect(w.runner.deliveries).toHaveLength(1);
  });

  test('GAP(deliver) settleStartup a start with no task waits for nothing (there is no first turn to time)', async () => {
    const w = await world();
    let asked = 0;
    w.runner.settled = async () => {
      asked += 1;
      return 'settled';
    };

    await started(w);

    expect(asked).toBe(0);
  });

  test('GAP(deliver) settleStartup the harness explains a parked death from the screen in its own fixed words, and the screen is never quoted', async () => {
    const w = await world();
    const SCREEN = 'Error: FIXTURE_SECRET workspace routing discovery failed (code -32603)';
    const screens: string[] = [];
    w.runner.settled = died(true);
    w.runner.lastScreen = async handle => {
      screens.push(handle);
      return SCREEN;
    };
    Object.assign(w.harness, {
      startFailure: (screen: string) =>
        screen.includes('workspace routing') ? 'Codex needs a network connection to start.' : undefined,
    });

    const result = await w.service.start({ folder: '/work', by: 'owner', prompt: 'Build the thing.' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(`Codex needs a network connection to start.${NEVER_RAN}`);
      expect(result.error.reason).not.toContain('FIXTURE_SECRET');
    }
    // The screen was read off this start's own pane, before the cleanup stopped it.
    expect(screens).toEqual(['%1']);
    expect(w.runner.stopped).toEqual(['%1']);
  });

  test('GAP(deliver) settleStartup a first turn that cannot be typed takes the harness explanation too; a harness that throws or says nothing keeps the fixed sentence', async () => {
    for (const [explain, reason] of [
      [() => 'Codex needs a network connection to start.', 'Codex needs a network connection to start.'],
      [
        () => {
          throw new Error('FIXTURE_SECRET');
        },
        "the ferret's assigned task could not be typed into its pane, so it was not started",
      ],
      [() => undefined, "the ferret's assigned task could not be typed into its pane, so it was not started"],
    ] as const) {
      const w = await world();
      w.runner.deliver = async () => {
        throw new Error('FIXTURE_SECRET pane refused');
      };
      w.runner.lastScreen = async () => 'FIXTURE_SECRET screen';
      Object.assign(w.harness, { startFailure: explain });

      const result = await w.service.start({ folder: '/work', by: 'owner', prompt: 'Build the thing.' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe(reason);
        expect(result.error.reason).not.toContain('FIXTURE_SECRET');
      }
    }
  });
});

describe('m2 a resume tells its caller what it decided, under the ferret’s own queue (ResumeOptions.decided)', () => {
  test('m2 a stopped ferret is relaunching, a running one is left running, a refused resume decided nothing', async () => {
    const w = await world();
    const id = await started(w);
    const told: string[] = [];
    const decided = (disposition: string) => void told.push(disposition);

    await w.service.resume(id as never, 'Again.', { decided });
    await w.service.stop(id as never, 'now');
    await w.service.resume(id as never, 'Again.', { decided });
    await w.service.resume('mw7bp88g-0000ffff' as never, 'Again.', { decided });

    expect(told).toEqual(['running', 'relaunching']);
  });

  test('m2 a caller whose answer throws never changes the resume', async () => {
    const w = await world();
    const id = await started(w);
    await w.service.stop(id as never, 'now');

    const resumed = await w.service.resume(id as never, undefined, {
      decided: () => {
        throw new Error('the caller broke');
      },
    });

    expect(resumed.ok).toBe(true);
    expect(w.registry.get(id as never)?.state).toBe('working');
  });
});

describe('M3 a resume tells its caller what it typed for the message (ResumeOptions.onCarried)', () => {
  test('M3 a relaunch with a message tells the caller the pointer it typed, the turn and the file, once and after the typing', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    const typedBefore = w.runner.deliveries.length;
    const told: { text: string; turn: number; file: string }[] = [];

    const resumed = await w.service.resume(id as never, 'Carry on.', {
      onCarried: typed => {
        // Told AFTER the pointer reached the pane, never before.
        expect(w.runner.deliveries).toHaveLength(typedBefore + 1);
        told.push(typed);
      },
    });

    expect(resumed.ok).toBe(true);
    expect(told).toEqual([{ text: turnFileInstruction(turnFile(w, id, 2)), turn: 2, file: turnFile(w, id, 2) }]);
    expect(w.runner.deliveries.at(-1)?.delivery.text).toBe(told[0]?.text);
  });

  test('M3 a running ferret was relaunched with nothing, so nothing is told', async () => {
    const w = await world();
    const id = await started(w);
    const told: unknown[] = [];

    await w.service.resume(id as never, 'Again.', { onCarried: typed => void told.push(typed) });

    expect(told).toEqual([]);
  });

  test('M3 a relaunch that fails tells nothing: no pointer was typed', async () => {
    const w = await world();
    const id = await started(w);
    await w.service.stop(id as never, 'now');
    w.runner.refuseStarts = 1;
    const told: unknown[] = [];

    const resumed = await w.service.resume(id as never, 'Again.', { onCarried: typed => void told.push(typed) });

    expect(resumed.ok).toBe(false);
    expect(told).toEqual([]);
  });

  test('M3 a caller whose answer throws never changes the resume', async () => {
    const w = await world();
    const id = await started(w);
    await w.service.stop(id as never, 'now');

    const resumed = await w.service.resume(id as never, 'Again.', {
      onCarried: () => {
        throw new Error('the caller broke');
      },
    });

    expect(resumed.ok).toBe(true);
    expect(w.registry.get(id as never)?.state).toBe('working');
  });
});

describe('FerretsApi.turns: a ferret’s turn documents, behind the mayTouch caller rule', () => {
  test('turns lists the start’s task and every revive’s turn, oldest first, with who each is from', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    await w.service.stop(id as never, 'now');
    await revive(w, id, 'Again.', 'admin-ui');

    const turns = await w.service.turns(id as never);

    expect(await turns?.list()).toEqual([
      { turn: 1, text: '# Assigned task\n\nBuild the thing.\n' },
      { turn: 2, text: `Again.\n\n${defaultSessionResumeSettings.turnProtocolReminder}\n`, by: { kind: 'owner' } },
    ]);
    expect(await w.service.turns('mw7bp88g-0000ffff' as never)).toBeUndefined();
  });

  test('a ferret reads its own and its helpers’ turns, and is refused anyone else’s with a 403', async () => {
    const w = await world();
    const lead = await started(w, 'Lead the work.');
    const helper = await started(w, 'Help.', { parent: lead });
    const stranger = await started(w, 'Something else.');

    expect((await (await w.service.turns(helper as never, lead as never))?.list())?.length).toBe(1);
    expect((await (await w.service.turns(lead as never, lead as never))?.list())?.length).toBe(1);
    await expect(w.service.turns(lead as never, stranger as never)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(w.service.turns(lead as never, helper as never)).rejects.toMatchObject({ status: 403 });
  });
});

describe('FerretHarness.queue: the runner’s own queue, never wrapped in a second act', () => {
  test('#23 pane-queue: the seam hands the text to the runner’s queue on the ferret’s pane and acts nothing itself', async () => {
    const w = await world();
    const id = await started(w);
    const seam = await w.service.harness(id as never);

    expect(await seam?.queue('FIXTURE queued words')).toEqual(ok('held'));

    expect(w.runner.queued).toEqual([
      { handle: w.registry.get(id as never)?.handle as never, text: 'FIXTURE queued words' },
    ]);
    // The runner acts per write itself; an outer act here would wait on the inner one forever. An interrupt is the
    // runner's own guarded stop key too (harness-refusals), so nothing on this seam is acted on twice.
    await seam?.interrupt();
    expect(w.runner.pressed).toEqual([{ handle: w.registry.get(id as never)?.handle as never, key: 'Escape' }]);
  });

  test('a stopped ferret has no pane to queue into, and a runner that cannot queue answers plugin_unavailable', async () => {
    const w = await world();
    const id = await started(w);
    const seam = await w.service.harness(id as never);
    (w.runner as { queue?: unknown }).queue = undefined;

    expect(await seam?.queue('x')).toEqual(err({ refused: 'plugin_unavailable' }));
    await w.service.stop(id as never, 'now');
    expect(await seam?.queue('x')).toEqual(err({ refused: 'no_pane' }));
  });
});

describe('ruling #45 (a): one look before deliver, so a send to a working ferret is answered busy at once', () => {
  /** A screen as the runner's `look` reads it: today's `activeWork` (the harness's working line) and no prompt. */
  const WORKING: RunnerLook = { frame: 'working', working: true, atPrompt: false, permission: false };
  /** The delivery's own readiness wait, standing in for its ~27 s: it never answers within the test's window. */
  const waitsOutItsReadiness = (w: World): void => {
    w.runner.deliver = async () => await new Promise<never>(() => undefined);
  };
  const within = async <T>(ms: number, work: Promise<T>): Promise<T | 'timed out'> =>
    await Promise.race([work, new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), ms))]);

  test('ruling #45 send to a working ferret answers in under 1 s: busy, nothing typed, the readiness wait never entered', async () => {
    const w = await world();
    const id = await started(w);
    const handle = w.registry.get(id as never)?.handle as RunnerHandle;
    w.runner.screens.set(handle, WORKING);
    waitsOutItsReadiness(w);
    const seam = await w.service.harness(id as never);

    const began = Date.now();
    expect(await within(1_000, seam!.deliver({ text: 'FIXTURE report to a busy lead' }))).toEqual(
      err({ refused: 'not_ready', why: 'busy' }),
    );
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(w.runner.looked).toEqual([handle]);
    expect(w.runner.deliveries).toEqual([]);
  });

  test('m2 a pane parked on a permission prompt is answered not_ready dialog at once: nothing typed, the readiness wait never entered', async () => {
    const w = await world();
    const id = await started(w);
    const handle = w.registry.get(id as never)?.handle as RunnerHandle;
    w.runner.screens.set(handle, { ...WORKING, permission: true });
    waitsOutItsReadiness(w);
    const seam = await w.service.harness(id as never);

    expect(await within(1_000, seam!.deliver({ text: 'FIXTURE words to a parked ferret' }))).toEqual(
      err({ refused: 'not_ready', why: 'dialog' }),
    );
    expect(w.runner.looked).toEqual([handle]);
    expect(w.runner.deliveries).toEqual([]);
  });

  test('ruling #45 a pane at its prompt, behind a harness dialog (a startup dialog the delivery answers), or one the look cannot read, goes on to the delivery', async () => {
    const screens: readonly [string, RunnerLook | undefined][] = [
      ['an idle prompt', { frame: 'idle', working: false, atPrompt: true, permission: false }],
      ['a working line under a prompt', { ...WORKING, atPrompt: true }],
      ['a harness dialog', { ...WORKING, prompt: 'FIXTURE dialog words' }],
      ['a dialog read as data', { ...WORKING, dialog: { kind: 'FIXTURE' } }],
      ['no work and no prompt (the record alone proves nothing)', { ...WORKING, working: false }],
    ];
    for (const [what, screen] of screens) {
      const w = await world();
      const id = await started(w);
      const handle = w.registry.get(id as never)?.handle as RunnerHandle;
      if (screen !== undefined) w.runner.screens.set(handle, screen);
      const seam = await w.service.harness(id as never);
      expect({ what, answer: await seam!.deliver({ text: 'FIXTURE words' }) }).toEqual({
        what,
        answer: ok('turn-started'),
      });
      expect(w.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['FIXTURE words']);
    }
  });

  test('ruling #45 a look that rejects or sees nothing decides nothing: the delivery runs as before', async () => {
    for (const look of [
      async () => {
        throw new Error('tmux could not be asked');
      },
      async () => undefined,
    ]) {
      const w = await world();
      const id = await started(w);
      w.runner.look = look;
      const seam = await w.service.harness(id as never);
      expect(await seam!.deliver({ text: 'FIXTURE words' })).toEqual(ok('turn-started'));
    }
    // A runner with no `look` at all is the same.
    const w = await world();
    const id = await started(w);
    (w.runner as { look?: unknown }).look = undefined;
    expect(await (await w.service.harness(id as never))!.deliver({ text: 'FIXTURE words' })).toEqual(
      ok('turn-started'),
    );
  });
});

describe("ruling #45 (b): a queued message over 1000 characters goes by file (today's native-file path)", () => {
  const queuedFile = (w: World, id: string, sendId: string) => `${w.folderOf(id)}/channel/queued-${sendId}.md`;
  const live = async (w: World) => {
    const id = await started(w);
    return { id, seam: (await w.service.harness(id as never))! };
  };

  test('ruling #45 a 5000-char payload goes by file: written 0600 first, and the queue is typed the one-line pointer', async () => {
    const w = await world();
    const { id, seam } = await live(w);
    // The mode THIS code asks for (the kernel clamps a private root's files too, so the file's mode alone proves the kernel).
    const handle = w.reuse.handles[id] as RootHandle;
    const publish = handle.publish.bind(handle);
    const asked: (number | undefined)[] = [];
    Object.assign(handle, {
      publish: async (...args: Parameters<RootHandle['publish']>) => {
        asked.push(args[2]?.mode);
        return await publish(...args);
      },
    });
    const payload = `FIXTURE long report\n${'x'.repeat(5_000 - 20)}`;
    expect(payload).toHaveLength(5_000);

    expect(await seam.queue(payload, { sendId: 'send-mw7a-0001' })).toEqual(ok('held'));

    const file = queuedFile(w, id, 'send-mw7a-0001');
    expect(w.runner.queued.map(entry => entry.text)).toEqual([queuedMessageInstruction(file)]);
    expect(await readFile(file, 'utf8')).toBe(`${payload}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(asked).toEqual([0o600]);
    // Nothing of the message itself went into the composer, and no temporary file was left beside it.
    expect(w.runner.queued[0]?.text).not.toContain('xxxx');
    expect(await readdir(`${w.folderOf(id)}/channel`)).toEqual(['queued-send-mw7a-0001.md']);
  });

  test('ruling #45 the 1000/1001 boundary: 1000 characters are typed inline, 1001 go by file', async () => {
    const w = await world();
    const { id, seam } = await live(w);
    const inline = 'a'.repeat(1_000);
    const byFile = 'b'.repeat(1_001);

    expect(await seam.queue(inline, { sendId: 'send-at' })).toEqual(ok('held'));
    expect(await seam.queue(byFile, { sendId: 'send-over' })).toEqual(ok('held'));

    expect(w.runner.queued.map(entry => entry.text)).toEqual([
      inline,
      queuedMessageInstruction(queuedFile(w, id, 'send-over')),
    ]);
    expect(await readdir(`${w.folderOf(id)}/channel`)).toEqual(['queued-send-over.md']);
  });

  test('ruling #45 the same send id rewrites the same file; none, or one outside the grammar, takes a fresh id inside channel/', async () => {
    const w = await world();
    const { id, seam } = await live(w);
    await seam.queue('c'.repeat(1_500), { sendId: 'send-again' });
    await seam.queue('d'.repeat(1_500), { sendId: 'send-again' });
    expect(await readFile(queuedFile(w, id, 'send-again'), 'utf8')).toBe(`${'d'.repeat(1_500)}\n`);

    await seam.queue('e'.repeat(1_500));
    await seam.queue('f'.repeat(1_500), { sendId: '../../escape' });
    const names = await readdir(`${w.folderOf(id)}/channel`);
    expect(names).toHaveLength(3);
    for (const name of names) expect(name).toMatch(/^queued-[\w-]{1,128}\.md$/u);
    expect(await readdir(w.folderOf(id))).not.toContain('escape');
    // Each fresh-id pointer typed names the very file that was written, and that file holds its own message.
    const fresh = names.filter(name => name !== 'queued-send-again.md');
    const typed = w.runner.queued.slice(-2).map(entry => entry.text);
    expect([...typed].sort()).toEqual(
      fresh.map(name => queuedMessageInstruction(`${w.folderOf(id)}/channel/${name}`)).sort(),
    );
    const held = await Promise.all(
      fresh.map(async name => await readFile(`${w.folderOf(id)}/channel/${name}`, 'utf8')),
    );
    expect(held.sort()).toEqual([`${'e'.repeat(1_500)}\n`, `${'f'.repeat(1_500)}\n`]);
  });

  test('ruling #45 two send ids that differ only by case never name one file (a filesystem that ignores case)', async () => {
    const w = await world();
    const { id, seam } = await live(w);
    await seam.queue('g'.repeat(1_500), { sendId: 'send-case' });
    await seam.queue('h'.repeat(1_500), { sendId: 'Send-Case' });

    const names = await readdir(`${w.folderOf(id)}/channel`);
    // The capitalised id takes a fresh lower-case name, so on macOS it could not have overwritten the first.
    expect(names).toHaveLength(2);
    expect(names).toContain('queued-send-case.md');
    for (const name of names) expect(name).toBe(name.toLowerCase());
    expect(await readFile(queuedFile(w, id, 'send-case'), 'utf8')).toBe(`${'g'.repeat(1_500)}\n`);
  });
});

describe('ruling #31b: the start writes the session document, and strict ancestry stays strict', () => {
  test('a start writes config.json the protocol accepts, with the stamp of who caused it, before its first history event', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.', { options: { label: 'batch-1', model: 'opus' } });

    const config = SessionConfigSchema.parse(await w.storage.readConfig(parseSessionId(id)));
    expect(config).toMatchObject({
      id,
      name: 'fern1',
      label: 'batch-1',
      cwd: '/work',
      mode: 'auto',
      turn: 1,
      model: 'opus',
    });
    expect(config.provenance).toBeDefined();
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id)))).toMatchObject({ id, turn: 1 });
  });

  test('a ferret that ran before the writer (journal only, indexed) is given its document at boot, so a child of it is stamped', async () => {
    const lead = IDS[0];
    const leadId = parseSessionId(lead);
    const record: FerretRecord = {
      format: 1,
      id: lead as never,
      name: 'wren',
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work',
      state: 'stopped',
      createdAt: T0,
      stateAt: T0,
    };
    // Before the writer: the lead holds only history.jsonl, which the session store indexes.
    const before = await world([record], undefined, false);
    await before.storage.append(leadId, 'session.stopped', { reason: 'fixture' });
    expect(before.storage.findSession(leadId)).toBeDefined();
    expect(await before.storage.readConfig(leadId)).toBeUndefined();
    // Today's rule, kept: with an indexed ferret holding no document, a child's stamp cannot be proved.
    const refused = await before.service.start({ folder: '/work', by: 'owner', parent: lead as never });
    expect(refused.ok).toBe(false);

    // A daemon restart: the boot backfill documents the lead, and the strict ancestry then accepts a child of it.
    const restarted = await world([record], before.reuse);
    expect(SessionConfigSchema.safeParse(await restarted.storage.readConfig(leadId)).success).toBe(true);
    const child = await started(restarted, 'Help.', { parent: lead });
    const stamped = SessionConfigSchema.parse(await restarted.storage.readConfig(parseSessionId(child)));
    expect(stamped.parent).toBe(lead);
    expect(stamped.provenance).toBeDefined();
  });

  test('strict ancestry stays strict: a damaged ancestor document still refuses a child’s start, quoting none of it', async () => {
    const w = await world();
    const lead = await started(w);
    // Damaged on disk as a crash or a hand edit would leave it (the store itself refuses to write such a document).
    w.state.plant(FerretConfigFile, '{"format": 1, "label": "FIXTURE_SECRET-', lead);

    const child = await w.service.start({ folder: '/work', by: 'owner', parent: lead as never });

    expect(child.ok).toBe(false);
    if (!child.ok) {
      expect(child.error.reason).toBe('where this ferret came from could not be recorded, so it was not started');
      expect(child.error.reason).not.toContain('FIXTURE_SECRET');
    }
  });
});

describe('ruling #45 BG-051 / BG-053: Conversation writes a send’s turn document and queued file through FerretTurns', () => {
  const channelFile = (w: World, id: string, sendId: string) => `${w.folderOf(id)}/channel/queued-${sendId}.md`;

  test('BG-051 FerretTurns.write numbers a send’s turn after the start’s and the revive’s, writes it 0600 and counts it', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    const turns = (await w.service.turns(id as never))!;

    const first = await turns.write!({ document: 'FIXTURE first send\n' });

    // The start's prompt is turn one, so a send is turn two; the answer names the very file the agent is pointed at.
    expect(first).toEqual({ turn: 2, file: turnFile(w, id, 2) });
    expect(await readFile(turnFile(w, id, 2), 'utf8')).toBe('FIXTURE first send\n');
    expect((await stat(turnFile(w, id, 2))).mode & 0o777).toBe(0o600);
    // Counted, so a revive after it numbers past it and never rewrites it.
    expect(SessionStateSchema.parse(await w.storage.readState(parseSessionId(id))).turn).toBe(2);
    expect((await turns.write!({ document: 'FIXTURE second send\n' })).turn).toBe(3);
    await w.service.stop(id as never, 'now');
    expect((await revive(w, id, 'Carry on.')).ok).toBe(true);
    expect(await readFile(turnFile(w, id, 2), 'utf8')).toBe('FIXTURE first send\n');
    expect((await turns.list()).map(document => document.turn)).toEqual([1, 2, 3, 4]);
  });

  test('BG-051 FerretTurns.write keeps its author beside the document, and none at all when it names none', async () => {
    const w = await world();
    const id = await started(w, 'Build the thing.');
    const turns = (await w.service.turns(id as never))!;

    await turns.write!({ document: 'FIXTURE from a peer\n', by: { kind: 'ferret', name: 'wren' } });
    await turns.write!({ document: 'FIXTURE from the owner\n' });

    const names = await readdir(`${w.folderOf(id)}/turns`);
    expect(names).toContain('turn-002.by.json');
    expect(names).not.toContain('turn-003.by.json');
    expect((await turns.list()).map(document => document.by?.kind)).toEqual([undefined, 'ferret', undefined]);
  });

  test('BG-051 FerretTurns.clearMarkers removes the markers a previous turn left, and only those', async () => {
    const w = await world();
    const id = await started(w);
    const turns = (await w.service.turns(id as never))!;
    for (const name of ['done.marker', 'needs-help.marker', 'process-exit.marker', 'summary.md'])
      await writeFile(`${w.folderOf(id)}/${name}`, 'x');

    await turns.clearMarkers!();

    const left = await readdir(w.folderOf(id));
    for (const marker of ['done.marker', 'needs-help.marker', 'process-exit.marker'])
      expect(left).not.toContain(marker);
    expect(left).toContain('summary.md');
  });

  test('BG-053 FerretTurns.writeQueued writes channel/queued-<send id>.md 0600, rewrites the same id, and answers the path', async () => {
    const w = await world();
    const id = await started(w);
    const turns = (await w.service.turns(id as never))!;

    const file = await turns.writeQueued!('send-mw7a-0007', `${'x'.repeat(1_200)}`);

    expect(file).toBe(channelFile(w, id, 'send-mw7a-0007'));
    expect(await readFile(file, 'utf8')).toBe(`${'x'.repeat(1_200)}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await turns.writeQueued!('send-mw7a-0007', 'FIXTURE again')).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('FIXTURE again\n');
    expect(await readdir(`${w.folderOf(id)}/channel`)).toEqual(['queued-send-mw7a-0007.md']);
  });

  test('BG-053 FerretTurns.writeQueued refuses an id outside the grammar and writes nothing (the row names the file; none is invented)', async () => {
    const w = await world();
    const id = await started(w);
    const turns = (await w.service.turns(id as never))!;

    for (const sendId of ['../../escape', 'Send-Upper', '', 'a'.repeat(129)])
      await expect(turns.writeQueued!(sendId, 'FIXTURE words')).rejects.toThrow('queued-message grammar');

    await expect(readdir(`${w.folderOf(id)}/channel`)).rejects.toThrow();
  });

  test('BG-051 a daemon whose session files are unbound offers no writer, so a caller types the message as it is', async () => {
    const w = await world();
    const id = await started(w);
    const bare = new FerretsService(w.registry, w.tokens, {
      ...(w.service as unknown as { ports: FerretsPorts }).ports,
      session: undefined,
    });

    const turns = (await bare.turns(id as never))!;

    expect(turns.write).toBeUndefined();
    expect(turns.writeQueued).toBeUndefined();
    expect(turns.clearMarkers).toBeUndefined();
  });
});

/**
 * `fy start -f` (V-0443): the files a start was given are planned by the attachment owner (a stand-in here; Conversation's
 * own is proved in its package), written into the ferret's own `attachments/` folder, and named in the opening turn.
 */
describe('V-0443 a start carries its attachments with the opening message', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const BASE64 = Buffer.from(PNG).toString('base64');
  /** An owner that plans each file straight into the folder it is told, and words one line for each. */
  const owner = (log: string[] = []): OpeningAttachmentsSource => ({
    plan: ({ attachments, directory }) => {
      log.push(directory);
      return ok({
        section: `\n## Attachments\n\n${attachments.map(item => `- ${item.filename}`).join('\n')}\n`,
        files: attachments.map(item => ({ file: `${directory}/${item.filename}`, contents: new Uint8Array(PNG) })),
      });
    },
  });
  const attached = { initialAttachments: [{ filename: 'shot.png', mime: 'image/png', base64: BASE64 }] };
  const options = (extra: Record<string, unknown>) => ({ options: extra });

  test('V-0443 the planned files are written 0600 into the ferret’s own attachments folder BEFORE the task that names them, and the opening turn carries the section', async () => {
    const asked: string[] = [];
    const w = await world([], undefined, true, owner(asked));
    const id = await started(w, 'Fix the layout shown in the screenshot.', options(attached));
    expect(asked).toEqual([`${w.folderOf(id)}/attachments`]);
    const written = `${w.folderOf(id)}/attachments/shot.png`;
    expect([...new Uint8Array(await readFile(written))]).toEqual([...PNG]);
    expect((await stat(written)).mode & 0o777).toBe(0o600);
    expect((await stat(`${w.folderOf(id)}/attachments`)).mode & 0o777).toBe(0o700);
    // The turn the agent is told to open names the file; the request's own words come first.
    expect(await readFile(turnFile(w, id, 1), 'utf8')).toBe(
      '# Assigned task\n\nFix the layout shown in the screenshot.\n\n## Attachments\n\n- shot.png\n\n',
    );
    expect(w.runner.deliveries.at(-1)?.delivery.text).toBe(turnFileInstruction(turnFile(w, id, 1)));
  });

  test('V-0443 the attachments are this start’s request alone: their bytes are never written into the ferret’s details', async () => {
    const w = await world([], undefined, true, owner());
    const id = await started(w, 'Fix it.', options({ ...attached, label: 'batch' }));
    const details = JSON.stringify(w.registry.detailsOf(id as never) ?? {});
    expect(details).toContain('batch');
    expect(details).not.toContain('initialAttachments');
    expect(details).not.toContain(BASE64);
  });

  test('V-0443 a start with files and no opening message, no owner for attachments, a refusal from the owner or a file that would leave the folder is refused before anything is written', async () => {
    const refusing: OpeningAttachmentsSource = {
      plan: () => err('a start may carry at most 16 attachments; this one carries 17'),
    };
    const escaping: OpeningAttachmentsSource = {
      plan: ({ directory }) =>
        ok({ section: '', files: [{ file: `${directory}/../environment.json`, contents: 'x' }] }),
    };
    const nested: OpeningAttachmentsSource = {
      plan: ({ directory }) => ok({ section: '', files: [{ file: `${directory}/deep/shot.png`, contents: 'x' }] }),
    };
    const cases: readonly [string, OpeningAttachmentsSource | undefined, string | undefined, string][] = [
      ['no prompt', owner(), undefined, 'attachments belong to an opening message'],
      ['no owner', undefined, 'Fix it.', 'the plugin that owns them is off'],
      ['the owner refuses', refusing, 'Fix it.', 'at most 16 attachments'],
      ['a file leaves the folder', escaping, 'Fix it.', 'outside the ferret'],
      ['a file goes into a sub-folder', nested, 'Fix it.', 'outside the ferret'],
    ];
    for (const [, source, prompt, reason] of cases) {
      const w = await world([], undefined, true, source);
      const result = await w.service.start({
        folder: '/work',
        by: 'owner',
        ...(prompt === undefined ? {} : { prompt }),
        options: { ...attached, ...(prompt === undefined ? { mode: 'interactive' as const } : {}) },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('refused');
        expect(result.error.reason).toContain(reason);
      }
      expect(w.registry.list()).toEqual([]);
      expect(w.runner.starts).toBe(0);
      expect(await readdir(w.folderOf(IDS[0])).catch(() => [])).toEqual([]);
    }
  });

  test('V-0443 a start without attachments is unchanged: the task is its prompt alone and no attachments folder is made', async () => {
    const asked: string[] = [];
    const w = await world([], undefined, true, owner(asked));
    const id = await started(w, 'Build the thing.');
    expect(asked).toEqual([]);
    expect(await readFile(turnFile(w, id, 1), 'utf8')).toBe('# Assigned task\n\nBuild the thing.\n');
    expect(await readdir(w.folderOf(id))).not.toContain('attachments');
  });
});
