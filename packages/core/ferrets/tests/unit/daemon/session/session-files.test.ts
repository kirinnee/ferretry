import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle, RootName, RootsPort } from '@ferretry/kernel/contract';
import { diskPaths, diskRoot, diskSessionsRoot } from '@ferretry/kernel/testing';
import { FileSessionEffectLedger } from '../../../../daemon/adapters/session/effects/file-session-effect-ledger.ts';
import {
  FileSessionEnvironmentStore,
  FileSessionTaskStore,
} from '../../../../daemon/adapters/session/lifecycle/index.ts';
import { SessionFiles, type SessionFilesDeps } from '../../../../daemon/modules/session-files.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { SessionConfigSchema } from '../../../../daemon/lib/protocol/session.ts';
import type { RegisteredAncestor } from '../../../../daemon/adapters/session/provenance/storage-session-ancestry.ts';
import { WARDEN_LABEL } from '../../../../daemon/lib/session/peers/warden-lifecycle.ts';
import { memoryStorage, sessionConfig } from '../../../support/daemon/storage.ts';
import { ok } from '@ferretry/std';
import { FerretConfigFile, FerretHistoryFiles, type FerretRecord } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';
import { createSessionEvent, encodeSessionEvent } from '../../../../daemon/lib/storage/journal.ts';

const NOW = '2026-11-08T10:00:00.000Z';
const FERRET = parseSessionId('mw7bp88g-50e00159');
const OTHER = parseSessionId('mw7bp88g-aaaa0001');
const parents: string[] = [];

afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const temporary = async (): Promise<string> => {
  const parent = await mkdtemp(`${tmpdir()}/fy-session-files-`);
  parents.push(parent);
  return parent;
};

/** A kernel whose roots port records every `roots.root(name, scope)` call and the handle it answered. */
function recordingKernel(handles: Readonly<Record<string, RootHandle>>, work: RootHandle) {
  const calls: { readonly name: RootName; readonly subfolder: string | undefined }[] = [];
  const received: RootHandle[] = [];
  const roots: Pick<RootsPort, 'root'> = {
    root: (name, scope) => {
      calls.push({ name, subfolder: scope?.subfolder });
      const handle = name === 'sessions' ? handles[scope?.subfolder ?? ''] : work;
      if (handle === undefined) throw new Error(`no handle for ${name} ${scope?.subfolder ?? ''}`);
      received.push(handle);
      return handle;
    },
  };
  return { roots, calls, received };
}

async function files(
  roots: Pick<RootsPort, 'root'>,
  warnings: string[] = [],
  fleet: readonly RegisteredAncestor[] = [],
  seed?: SessionFilesDeps['seed'],
) {
  const { storage, folder } = await memoryStorage({ clock: { now: () => NOW } });
  const subject = new SessionFiles({
    roots,
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => fleet,
    ...(seed === undefined ? {} : { seed }),
    log: { warn: message => void warnings.push(message) },
  });
  return { subject, storage, folder };
}

async function wired() {
  const parent = await temporary();
  const first = await diskSessionsRoot(parent, FERRET);
  const second = await diskSessionsRoot(`${parent}/two`, OTHER);
  const work = await diskRoot(`${parent}/work`);
  const kernel = recordingKernel({ [FERRET]: first.root, [OTHER]: second.root }, work.root);
  return { ...kernel, first, work, parent };
}

describe('GAP(composition) the environment store, task store and effect ledger are built only on an internal root', () => {
  test('GAP(composition) 1-2: every roots.root call is the sessions root scoped to one ferret, and every handle a store gets is internal', async () => {
    // Arrange
    const kernel = await wired();
    const { subject } = await files(kernel.roots);

    // Act: build everything the Ferrets half builds on a ferret's root, for two ferrets
    for (const id of [FERRET, OTHER]) {
      subject.environmentStore(id);
      subject.taskStore(id);
      subject.effectLedger(id);
      subject.createLifecycle(id);
      await subject.environment.read(id).catch(() => undefined);
      await subject.port.prepare(ferretId(id));
    }

    // Assert
    expect(kernel.calls.length).toBeGreaterThan(0);
    expect(kernel.calls.every(call => call.name === 'sessions')).toBe(true);
    expect(new Set(kernel.calls.map(call => call.subfolder))).toEqual(new Set([FERRET, OTHER]));
    expect(kernel.received.every(handle => handle.internal === true && handle.name === 'sessions')).toBe(true);
  });

  test('BG-036 removeEnvironment deletes an ended ferret’s file, and leaves a ferret that was resumed first (it has a new credential)', async () => {
    // Arrange: a ferret holding an environment file.
    const kernel = await wired();
    const { subject } = await files(kernel.roots);
    await subject.environmentStore(FERRET).write(FERRET, { A: 'fixture' });

    // Act: the one still ended is removed; asked again while the registry no longer says ended, it stays.
    await subject.removeEnvironment(FERRET, () => true);
    const keptEnded = await subject.environmentStore(FERRET).read(FERRET);
    await subject.environmentStore(FERRET).write(FERRET, { A: 'new-credential-fixture' });
    await subject.removeEnvironment(FERRET, () => false);

    // Assert
    expect(keptEnded).toEqual({});
    expect(await subject.environmentStore(FERRET).read(FERRET)).toEqual({ A: 'new-credential-fixture' });
  });

  test('M6b removeEnvironment waits on the ferret’s serial queue: a start that is still writing its new environment is not undone', async () => {
    // Arrange: a start holds the ferret's queue. It writes the new credential, then (still inside the queue) the
    // registry flips to running, but only once the gate opens.
    const kernel = await wired();
    const { subject } = await files(kernel.roots);
    let ended = true;
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (openGate = resolve));
    let written: () => void = () => undefined;
    const wroteNew = new Promise<void>(resolve => (written = resolve));
    const starting = subject.serial.run(FERRET, async () => {
      await subject.environmentStore(FERRET).write(FERRET, { A: 'new-credential-fixture' });
      written();
      await gate;
      ended = false;
    });
    await wroteNew;

    // Act: the end path asks to remove the file while the start is still in the queue, then the start finishes.
    const removing = subject.removeEnvironment(FERRET, () => ended);
    await new Promise(resolve => setTimeout(resolve, 20));
    const whileGated = await subject.environmentStore(FERRET).read(FERRET);
    openGate();
    await Promise.all([starting, removing]);

    // Assert: the remove ran after the start, saw the ferret running, and left the new credential alone.
    expect(whileGated).toEqual({ A: 'new-credential-fixture' });
    expect(await subject.environmentStore(FERRET).read(FERRET)).toEqual({ A: 'new-credential-fixture' });
  });

  test('GAP(composition) 3: a work handle passed to any of the three constructors throws at construction', async () => {
    // Arrange
    const { work } = await wired();

    // Act + Assert
    expect(() => new FileSessionEnvironmentStore(work.root, FERRET)).toThrow(
      /internal sessions root only \(got work\)/u,
    );
    expect(() => new FileSessionTaskStore(work.root, FERRET)).toThrow(/internal sessions root only \(got work\)/u);
    expect(() => new FileSessionEffectLedger(work.root, FERRET)).toThrow(/internal sessions root only \(got work\)/u);
  });

  test('GAP(composition) 3: a handle that says it is not internal is refused even when it is named sessions', async () => {
    // Arrange
    const { first } = await wired();
    const lying: RootHandle = { ...first.root, internal: false };

    // Act + Assert
    expect(() => new FileSessionEnvironmentStore(lying, FERRET)).toThrow(/internal sessions root only/u);
    expect(() => new FileSessionTaskStore(lying, FERRET)).toThrow(/internal sessions root only/u);
    expect(() => new FileSessionEffectLedger(lying, FERRET)).toThrow(/internal sessions root only/u);
  });

  test('GAP(composition) a store built for one ferret refuses a call that names another, rather than writing into this folder', async () => {
    // Arrange
    const { first } = await wired();

    // Act + Assert
    expect(() => new FileSessionEnvironmentStore(first.root, FERRET).file(OTHER)).toThrow(/through the folder of/u);
    expect(() => new FileSessionTaskStore(first.root, FERRET).file(OTHER)).toThrow(/through the folder of/u);
    expect(() =>
      new FileSessionEffectLedger(first.root, FERRET).file({ sessionId: OTHER, effectId: 'turn-1' }),
    ).toThrow(/through the folder of/u);
  });

  test('GAP(composition) 4: the handle the stores get is the kernel sessions root scoped to the ferret folder', async () => {
    // The kernel half (base, no fence, leftover adoption on sessions and not on work) is pinned in
    // `packages/core/kernel/tests/unit/host/sessions-root.test.ts` ("K1 the base is …", "K1 a record with its own
    // leftover temp link is readable …", "K1 the same leftover on a work root stays refused …").
    // Arrange
    const kernel = await wired();
    const { subject } = await files(kernel.roots);
    await subject.port.prepare(ferretId(FERRET));

    // Act
    const handle = subject.root(FERRET);
    const environment = handle.resolve('environment.json');

    // Assert: the kernel's own sessions handle for this ferret, resolving inside the ferret's folder
    expect(handle).toBe(kernel.first.root);
    expect(handle.name).toBe('sessions');
    expect(handle.internal).toBe(true);
    expect(environment.ok ? environment.value : environment.error).toEndWith(
      `/state/ferrets/sessions/${FERRET}/environment.json`,
    );
  });
});

describe('the ferret folder and the environment: what the store never does', () => {
  test('use, never read: the store hands a launch its environment and exposes nothing else about it', async () => {
    // Arrange
    const kernel = await wired();
    const { subject } = await files(kernel.roots);

    // Act
    await subject.environment.write(FERRET, { FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });

    // Assert: the composition offers read and write by id for the launch and the rotation, and no listing or export
    expect(Object.keys(subject.environment).sort()).toEqual(['read', 'write']);
    expect(await subject.environment.read(FERRET)).toEqual({ FY_SESSION_BOARD_CAPABILITY: 'fixture-value' });
  });

  test('a damaged environment document is refused without quoting any of it', async () => {
    // Arrange
    const kernel = await wired();
    const { subject } = await files(kernel.roots);
    await subject.environment.write(FERRET, { A: 'b' });
    const target = kernel.first.root.resolve('environment.json');
    if (!target.ok) throw new Error(target.error);
    await kernel.first.root.publish(target.value, new TextEncoder().encode('{"FIXTURE_SECRET": 7'), { mode: 0o600 });

    // Act
    const failure = await subject.environment.read(FERRET).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Assert
    expect(failure?.message).toContain('is not a valid environment document');
    expect(failure?.message).not.toContain('FIXTURE_SECRET');
  });
});

describe('unbuilt adapters: provenance', () => {
  async function started(label?: string) {
    const kernel = await wired();
    const warnings: string[] = [];
    const { subject, storage } = await files(kernel.roots, warnings);
    await storage.writeConfig(FERRET, sessionConfig(FERRET, label === undefined ? {} : { label }));
    return { subject, storage, warnings };
  }
  const provenanceOf = async (storage: Awaited<ReturnType<typeof files>>['storage'], id = FERRET) => {
    const parsed = SessionConfigSchema.parse(await storage.readConfig(id));
    return { provenance: parsed.provenance, label: parsed.label };
  };

  test('unbuilt adapters: a start stamps provenance and a resume carries the stamp forward, the stored document winning', async () => {
    // Arrange
    const { subject, storage } = await started();

    // Act: a start with a person behind it, then a resume
    await subject.port.stamp({ id: FERRET, requestedByHuman: true });
    const atStart = await provenanceOf(storage);
    await subject.port.carry(ferretId(FERRET));
    const afterResume = await provenanceOf(storage);

    // Assert: stamped at the start; the resume left every spawn fact exactly as the stored stamp had it
    expect(atStart.provenance).toMatchObject({ v: 1, at: NOW, origin: 'human', wardenLineage: false });
    expect(afterResume.provenance).toEqual(atStart.provenance);
    expect(afterResume.provenance?.parent).toBeUndefined();
  });

  test('unbuilt adapters: a retried start over a stamped document never rewrites the stamp', async () => {
    // Arrange
    const { subject, storage } = await started();
    await subject.port.stamp({ id: FERRET, requestedByHuman: true });
    const first = await provenanceOf(storage);

    // Act
    await subject.port.stamp({ id: FERRET, parent: 'p', requestedByHuman: false });

    // Assert
    expect((await provenanceOf(storage)).provenance).toEqual(first.provenance);
  });

  test('unbuilt adapters: a resume carries the label the document holds, so the group the session belongs to is not dropped', async () => {
    // Arrange
    const { subject, storage } = await started('team');
    await subject.port.stamp({ id: FERRET, label: 'team', requestedByHuman: true });

    // Act: the resume is handed the id and nothing else; the label is the document's
    await subject.port.carry(ferretId(FERRET));

    // Assert
    expect((await provenanceOf(storage)).label).toBe('team');
  });

  test('unbuilt adapters: a start with no session document records nothing, refuses nothing and says so', async () => {
    // Arrange
    const kernel = await wired();
    const warnings: string[] = [];
    const { subject, storage } = await files(kernel.roots, warnings);

    // Act
    await subject.port.stamp({ id: FERRET, requestedByHuman: true });
    await subject.port.carry(ferretId(FERRET));

    // Assert: no document was invented for it
    expect(await storage.readConfig(FERRET)).toBeUndefined();
    expect(warnings).toEqual(['a ferret has no session document yet, so its spawn stamp was not recorded']);
  });

  /**
   * The child (FERRET) has a document naming its parent (OTHER), which is what a resume restamps from; the parent is
   * registered under a NON-warden requested label.
   */
  async function underParent(parentDocument: 'damaged' | 'unreadable' | 'missing' | Record<string, unknown>) {
    const kernel = await wired();
    const { subject, storage, folder } = await files(kernel.roots, [], [{ id: OTHER, label: 'team' }]);
    await storage.writeConfig(FERRET, sessionConfig(FERRET, { parent: OTHER }));
    if (parentDocument === 'unreadable') folder.plant(FerretConfigFile, '{"format": 1, "label": "fleet-', OTHER);
    // Valid JSON the session schema refuses: the stamp the parent carried is no longer a stamp.
    else if (parentDocument === 'damaged')
      folder.plant(
        FerretConfigFile,
        JSON.stringify({ format: 1, ...sessionConfig(OTHER, { label: WARDEN_LABEL }), provenance: { v: 99 } }),
        OTHER,
      );
    else if (parentDocument !== 'missing') await storage.writeConfig(OTHER, sessionConfig(OTHER, parentDocument));
    return { subject, storage };
  }
  const childOf = { id: FERRET, parent: OTHER, requestedByHuman: false } as const;

  test('unbuilt adapters: a damaged ancestor document refuses the start stamp (the start is refused)', async () => {
    for (const damage of ['damaged', 'unreadable'] as const) {
      // Arrange
      const { subject, storage } = await underParent(damage);

      // Act
      const refused = await subject.port.stamp(childOf).then(
        () => false,
        () => true,
      );

      // Assert: refused, and the child was not stamped `wardenLineage: false` behind the parent's back
      expect(refused).toBe(true);
      expect((await provenanceOf(storage)).provenance).toBeUndefined();
    }
  });

  test('unbuilt adapters: a resume over a damaged ancestor leaves the stored stamp untouched', async () => {
    for (const damage of ['damaged', 'unreadable'] as const) {
      // Arrange: a child whose document carries no stamp yet, which a resume would otherwise write
      const { subject, storage } = await underParent(damage);
      const before = await storage.readConfig(FERRET);

      // Act
      const refused = await subject.port.carry(ferretId(FERRET)).then(
        () => false,
        () => true,
      );

      // Assert: the recorder raised before it wrote, so the document is exactly as it was
      expect(refused).toBe(true);
      expect(await storage.readConfig(FERRET)).toEqual(before);
    }
  });

  test('unbuilt adapters: an ancestor label is the one its document holds, so the forced warden label shields the child', async () => {
    // Arrange: the registry still says `team` (what was asked); the document says `fleet-warden` (what was forced)
    const { subject, storage } = await underParent({ label: WARDEN_LABEL });

    // Act
    await subject.port.stamp(childOf);

    // Assert: the warden shield holds
    const stamped = await provenanceOf(storage);
    expect(stamped.provenance).toMatchObject({ origin: 'warden', wardenLineage: true, warden: OTHER });
    expect(stamped.label).toBe(WARDEN_LABEL);
  });

  test('unbuilt adapters: an ancestor stamp in its document shields the child, and a resume keeps it', async () => {
    // Arrange: the parent was stamped warden-descended; its own label has since drifted to `team`
    const wardenStamp = {
      v: 1,
      at: NOW,
      origin: 'warden',
      warden: 'mw7bp88g-aaaa0002',
      wardenLineage: true,
      lineageSource: 'self_label',
    };
    const { subject, storage } = await underParent({ label: 'team', provenance: wardenStamp });

    // Act
    await subject.port.carry(ferretId(FERRET));

    // Assert
    expect((await provenanceOf(storage)).provenance).toMatchObject({
      wardenLineage: true,
      lineageSource: 'parent_stamp',
    });
  });

  test('unbuilt adapters: a registered ancestor with no session document carries no stamp, and the start goes on', async () => {
    // Arrange: no parent document; the registry's requested label is all there is
    const plain = await underParent('missing');
    const kernel = await wired();
    const warden = await files(kernel.roots, [], [{ id: OTHER, label: WARDEN_LABEL }]);
    await warden.storage.writeConfig(FERRET, sessionConfig(FERRET));

    // Act
    await plain.subject.port.stamp(childOf);
    await warden.subject.port.stamp(childOf);

    // Assert: stamped, never refused; the registry's label is what decides, for lack of a document
    expect((await provenanceOf(plain.storage)).provenance).toMatchObject({ wardenLineage: false });
    expect((await provenanceOf(warden.storage)).provenance).toMatchObject({ wardenLineage: true, warden: OTHER });
  });

  /**
   * Ferrets' own service over the real session files, so a resume is driven by exactly the request it builds in the
   * daemon. The registry knows the child (FERRET) as it was ASKED to be: label `team`, no parent. Its session document
   * may say otherwise; the parent (OTHER) is not registered, only indexed through its document.
   */
  async function resumedByTheService(childDocument: Record<string, unknown>, parentDocument: Record<string, unknown>) {
    const kernel = await wired();
    const { storage } = await memoryStorage({ clock: { now: () => NOW } });
    const child: FerretRecord = {
      format: 1,
      id: ferretId(FERRET),
      name: 'child',
      role: 'lead',
      harness: 'claude-code',
      runner: 'tmux',
      folder: '/work',
      state: 'stopped',
      createdAt: T0,
      stateAt: T0,
    };
    const registry = new FerretRegistry([child]);
    registry.putDetails(child.id, { options: { label: 'team' } });
    const subject = new SessionFiles({
      roots: kernel.roots,
      storage,
      clock: { now: () => NOW },
      sleep: async () => undefined,
      paths: diskPaths(),
      // The daemon's own wiring (daemon/index.ts): the registry's requested label and its parent link.
      fleet: () =>
        registry.list().map(ferret => {
          const label = registry.detailsOf(ferret.id)?.options?.label;
          return {
            id: ferret.id,
            ...(label === undefined ? {} : { label }),
            ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
          };
        }),
      log: { warn: () => undefined },
    });
    await storage.writeConfig(OTHER, sessionConfig(OTHER, parentDocument));
    await storage.writeConfig(FERRET, sessionConfig(FERRET, childDocument));
    // A session's state document is written with its config (a revive counts its turn there, before the relaunch).
    await storage.upsertState(FERRET, () => ({ id: FERRET, status: 'stopped', turn: 0 }));
    const harness = new FakeHarness();
    const runner = new FakeRunner();
    const service = new FerretsService(registry, new FerretTokenDirectory(), {
      now: () => T0,
      newId: () => ferretId('never-minted'),
      newName: () => 'never-named',
      save: async () => {},
      saveTokens: async () => {},
      harness: () => harness,
      harnessKeys: () => [harness.key],
      runner: () => runner,
      decide: async () => ({ allow: true }),
      launchParts: () => [],
      sitrepSources: () => [],
      instructions: () => [],
      folder: path => ok(fenced(path)),
      changed: () => {},
      vault: { childEnvironment: async () => ok(emptyChildEnvironment()) },
      asks: { open: async () => [] },
      session: subject.port,
    });
    return { resumed: await service.resume(child.id, undefined, { origin: PERSON_ORIGIN }), storage };
  }

  test('unbuilt adapters: a resume takes label and parent from the session document, so a warden parent the registry does not name still shields the child', async () => {
    // Arrange: the document names a warden parent and an owner's label; the registry names neither
    const { resumed, storage } = await resumedByTheService(
      { parent: OTHER, label: 'edited-by-owner' },
      { label: WARDEN_LABEL },
    );

    // Assert: today's recorder restamps from the document, so the child is warden offspring for good
    expect(resumed.ok).toBe(true);
    const stamped = await provenanceOf(storage);
    expect(stamped.provenance).toMatchObject({ origin: 'warden', wardenLineage: true, warden: OTHER, parent: OTHER });
    // The label is the one the warden stamp forces (today's), and never the registry's `team`.
    expect(stamped.label).toBe(WARDEN_LABEL);
  });

  test('unbuilt adapters: a resume keeps the label the owner gave the session document, not the label the registry was asked for', async () => {
    // Arrange: an ordinary parent, an owner's edited label, and a registry that still says `team` with no parent
    const { resumed, storage } = await resumedByTheService(
      { parent: OTHER, label: 'edited-by-owner' },
      { label: 'crew' },
    );

    // Assert
    expect(resumed.ok).toBe(true);
    const stamped = await provenanceOf(storage);
    expect(stamped.label).toBe('edited-by-owner');
    expect(stamped.provenance).toMatchObject({ origin: 'session', wardenLineage: false, parent: OTHER });
  });

  test("unbuilt adapters: a resume over the session's own damaged document writes nothing and quotes none of it", async () => {
    // Arrange: valid JSON the session schema refuses (today's `sessions.get` throws on it)
    const kernel = await wired();
    const { subject, folder } = await files(kernel.roots);
    const damaged = JSON.stringify({
      format: 1,
      ...sessionConfig(FERRET, { label: 'FIXTURE_SECRET' }),
      provenance: { v: 99 },
    });
    folder.plant(FerretConfigFile, damaged, FERRET);

    // Act
    const failure = await subject.port.carry(ferretId(FERRET)).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );

    // Assert: refused, named by id only, and the document is byte-for-byte as it was
    expect(failure?.message).toContain(FERRET);
    expect(failure?.message).not.toContain('FIXTURE_SECRET');
    expect(folder.raw(FerretConfigFile, FERRET)).toBe(damaged);
  });

  /**
   * GAP(provenance), pinned. In 5.0 every ferret Ferrets' own service has stopped or resumed holds ONLY history.jsonl
   * (daemon/index.ts `appendHistory` writes it; nothing writes config.json), and DaemonStorage indexes a folder holding
   * only a journal on any sweep, replay or append. Today's strict rule then refuses every stamp. The read stays STRICT
   * (relaxing it brings back the fail-open for a vanished document); the document writer that closes GAP(provenance)
   * must write config.json before the first history event and give every ferret that already has a journal a
   * document, or the first documented start after it lands is refused fleet-wide.
   */
  test('GAP(provenance) an indexed session with no config.json refuses every stamp: a ferret holding only history.jsonl, once indexed, refuses a documented start and its resume writes nothing', async () => {
    // Arrange: OTHER is a registered service ferret whose folder holds only a journal, written as appendHistory does
    const kernel = await wired();
    const { subject, storage, folder } = await files(kernel.roots, [], [{ id: OTHER, label: 'team' }]);
    await folder
      .port([FerretHistoryFiles])
      .append(FerretHistoryFiles, encodeSessionEvent(createSessionEvent(OTHER, 0, NOW, 'ferret.stopped', {})), OTHER);
    await storage.rebuildIndex();
    expect(storage.listSessions().map(session => session.id)).toContain(OTHER);
    expect(await storage.readConfig(OTHER)).toBeUndefined();
    await storage.writeConfig(FERRET, sessionConfig(FERRET));
    const before = await storage.readConfig(FERRET);

    // Act
    const start = await subject.port.stamp({ id: FERRET, requestedByHuman: true }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const resume = await subject.port.carry(ferretId(FERRET)).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    // Assert: both refused by today's "disappeared" rule, and the documented ferret was stamped neither way
    expect(start).toBe(`indexed session ${OTHER} disappeared while its spawn ancestry was being read`);
    expect(resume).toBe(start);
    expect(await storage.readConfig(FERRET)).toEqual(before);
  });

  /**
   * GAP(provenance), pinned. Today's start always takes the spawn ancestry snapshot, so a damaged, unreadable or
   * vanished ancestor refuses EVERY start. The session-document writer (ruling #31b) now makes a document for every
   * ferret the registry holds before its stamp, so the daemon's starts take that snapshot as today's do
   * (`deliver-turns.test.ts`). This pins the one branch left: a start for a ferret the registry holds NO record of
   * (this fixture binds no `seed`) has no document to make, returns before the snapshot and records nothing; the same
   * ancestry DOES refuse once the child has a document.
   */
  test('GAP(provenance) a start the registry holds no record for has no document to make, so it records nothing and its ancestry is never checked; once it has a document the same ancestry refuses', async () => {
    for (const damage of ['damaged', 'unreadable', 'vanished'] as const) {
      // Arrange: the child (FERRET) has no document; its registered parent (OTHER) is damaged, or indexed with none
      const kernel = await wired();
      const warnings: string[] = [];
      const { subject, storage, folder } = await files(kernel.roots, warnings, [{ id: OTHER, label: 'team' }]);
      if (damage === 'unreadable') folder.plant(FerretConfigFile, '{"format": 1, "label": "fleet-', OTHER);
      else if (damage === 'damaged')
        folder.plant(
          FerretConfigFile,
          JSON.stringify({ format: 1, ...sessionConfig(OTHER, { label: WARDEN_LABEL }), provenance: { v: 99 } }),
          OTHER,
        );
      else {
        await folder
          .port([FerretHistoryFiles])
          .append(
            FerretHistoryFiles,
            encodeSessionEvent(createSessionEvent(OTHER, 0, NOW, 'ferret.stopped', {})),
            OTHER,
          );
        await storage.rebuildIndex();
      }

      // Act
      const start = await subject.port.stamp({ id: FERRET, parent: OTHER, requestedByHuman: false }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      // Assert: not refused, nothing written for the child, and the log line is the only trace
      expect(start).toBeUndefined();
      expect(await storage.readConfig(FERRET)).toBeUndefined();
      expect(warnings).toEqual(['a ferret has no session document yet, so its spawn stamp was not recorded']);

      // Contrast: the same ancestry refuses the start as soon as the child has a document (the snapshot is taken).
      // The document is the child's own, written as it lands on disk (a write naming a damaged parent is refused).
      folder.plant(
        FerretConfigFile,
        JSON.stringify({ format: 1, ...sessionConfig(FERRET, { parent: OTHER }) }),
        FERRET,
      );
      const documented = await subject.port.stamp({ id: FERRET, parent: OTHER, requestedByHuman: false }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      // refused for the ANCESTOR, quoting none of its bytes
      expect(documented).toContain(OTHER);
      expect(documented).not.toContain('fleet-');
    }
  });
});

describe('ci-lane-s F1 (row 55) a start the port admitted as outside the Warden’s tree is refused by the stamp when lineage resolves true', () => {
  async function under(parentDocument: Record<string, unknown>) {
    const kernel = await wired();
    const { subject, storage } = await files(kernel.roots, [], [{ id: OTHER, label: 'team' }]);
    await storage.writeConfig(FERRET, sessionConfig(FERRET, { parent: OTHER }));
    await storage.writeConfig(OTHER, sessionConfig(OTHER, parentDocument));
    return { subject, storage };
  }
  const provenanceOf = async (storage: Awaited<ReturnType<typeof files>>['storage']) =>
    SessionConfigSchema.parse(await storage.readConfig(FERRET)).provenance;
  const admitted = { id: FERRET, parent: OTHER, requestedByHuman: false, notInWardenTree: true } as const;

  test('a parent whose document marks it in the Warden’s tree refuses the admitted start, and nothing is stamped', async () => {
    const { subject, storage } = await under({ label: WARDEN_LABEL });

    const refused = await subject.port.stamp(admitted).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refused).toBe('a start the port admitted as outside the Warden’s tree would be stamped into it');
    expect(await provenanceOf(storage)).toBeUndefined();
  });

  test('the same start without the admission is stamped into the Warden’s lineage, as the route’s start is', async () => {
    const { subject, storage } = await under({ label: WARDEN_LABEL });

    await subject.port.stamp({ id: FERRET, parent: OTHER, requestedByHuman: false });

    expect(await provenanceOf(storage)).toMatchObject({ origin: 'warden', wardenLineage: true });
  });

  test('an admitted start under an ordinary parent is stamped as before', async () => {
    const { subject, storage } = await under({ label: 'team' });

    await subject.port.stamp(admitted);

    expect(await provenanceOf(storage)).toMatchObject({ origin: 'session', wardenLineage: false, parent: OTHER });
  });
});

describe('ci-lane-s-r2 N1 (row 58) the lineage question waits for the document backfill, as the start’s stamp does', () => {
  test('in the boot window an indexed parent with no document yet is answered after the backfill, not refused', async () => {
    // Arrange: the parent has only a history file (indexed, no document); the registry can seed one for it
    const kernel = await wired();
    const { subject, storage, folder } = await files(kernel.roots, [], [{ id: OTHER, label: 'team' }], id => ({
      record: {
        format: 1,
        id: ferretId(id),
        name: 'parent',
        role: 'lead',
        harness: 'claude-code',
        runner: 'tmux',
        folder: '/work',
        state: 'stopped',
        createdAt: T0,
        stateAt: T0,
      },
      details: undefined,
    }));
    await folder
      .port([FerretHistoryFiles])
      .append(FerretHistoryFiles, encodeSessionEvent(createSessionEvent(OTHER, 0, NOW, 'ferret.stopped', {})), OTHER);
    await storage.rebuildIndex();
    let release: (ferrets: readonly string[]) => void = () => undefined;
    const backfilling = subject.backfill(
      () =>
        new Promise<readonly string[]>(resolve => {
          release = resolve;
        }),
    );

    // Act: asked while the backfill is still running, then the backfill finishes
    const asked = subject.port.inWardenLineage!(ferretId(OTHER));
    release([OTHER]);
    await backfilling;

    // Assert: answered (not in the tree), where an unawaited snapshot would have thrown for the missing document
    expect(await asked).toBe(false);
  });
});

describe('the ferret folder is held private when a ferret starts', () => {
  test('F-0303 prepare makes the per-ferret folder 0700 and narrows an existing wider one', async () => {
    // Arrange
    const kernel = await wired();
    const { subject } = await files(kernel.roots);
    await mkdir(kernel.first.folder, { mode: 0o755, recursive: true });
    await chmod(kernel.first.folder, 0o755);

    // Act
    await subject.port.prepare(ferretId(FERRET));

    // Assert
    expect((await lstat(kernel.first.folder)).mode & 0o777).toBe(0o700);
  });
});
