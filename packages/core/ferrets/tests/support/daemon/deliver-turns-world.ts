import { afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '@ferretry/kernel/contract';
import { diskPaths, diskSessionsRoot, type MemoryStateFolder } from '@ferretry/kernel/testing';
import { err, ok, type Result } from '@ferretry/std';
import {
  PERSON_ORIGIN,
  type FerretRecord,
  type OpeningAttachmentsSource,
  type RunnerHandle,
  type RunningFerret,
  type RunSpec,
  type StartRefusal,
} from '../../../contract/index.ts';
import { emptyChildEnvironment, FakeHarness, FakeRunner, fenced, T0 } from '../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../daemon/lib/tokens/tokens.ts';
import { SessionFiles } from '../../../daemon/modules/session-files.ts';
import { memoryStorage } from './storage.ts';

/** The deliver seam's fixture daemon: shared by the unit file and the perf file that holds its timing claim. */

const NOW = '2026-11-08T10:00:00.000Z';
export const IDS = ['mw7bp88g-00000001', 'mw7bp88g-00000002', 'mw7bp88g-00000003', 'mw7bp88g-00000004'] as const;
export const parents: string[] = [];
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

export interface World {
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
  /** Every history event the service recorded, in order. */
  readonly history: {
    readonly ferret: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[];
}

/** One daemon over ferret folders that outlive it: `restart` builds the next one on the same state and disk. */
export async function world(
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
      // The scope a send's file writer holds: the ferret's `attachments` folder alone, on the same real home.
      made[`${id}/attachments`] = (await diskSessionsRoot(parent, `${id}/attachments`)).root;
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
  const history: World['history'][number][] = [];
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
    history: async (ferret, type, data) => void history.push({ ferret, type, data }),
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
    history,
    reuse: { state, handles, folders },
  };
}

export const turnFile = (w: World, id: string, turn: number) =>
  `${w.folderOf(id)}/turns/turn-${String(turn).padStart(3, '0')}.md`;

export async function started(w: World, prompt?: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await w.service.start(
    {
      folder: '/work',
      by: 'owner',
      ...(prompt === undefined ? {} : { prompt }),
      ...extra,
    },
    PERSON_ORIGIN,
  );
  if (!result.ok) throw new Error(`start refused: ${result.error.reason}`);
  return result.value;
}
