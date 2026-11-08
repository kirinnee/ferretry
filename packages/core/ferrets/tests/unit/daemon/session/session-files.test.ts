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
import { SessionFiles } from '../../../../daemon/modules/session-files.ts';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { SessionConfigSchema } from '../../../../daemon/lib/protocol/session.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { memoryStorage, sessionConfig } from '../../../support/daemon/storage.ts';

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

async function files(roots: Pick<RootsPort, 'root'>, warnings: string[] = []) {
  const { storage } = await memoryStorage({ clock: { now: () => NOW } });
  const subject = new SessionFiles({
    roots,
    storage,
    clock: { now: () => NOW },
    sleep: async () => undefined,
    paths: diskPaths(),
    fleet: () => [],
    log: { warn: message => void warnings.push(message) },
  });
  return { subject, storage };
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

  test('GAP(composition) 4: the kernel pairs it (sessions-root.test.ts): base, no fence, leftover adoption on sessions and not on work', () => {
    // The kernel half is `packages/core/kernel/tests/unit/host/sessions-root.test.ts` ("K1 the base is …",
    // "K1 a record with its own leftover temp link is readable …", "K1 the same leftover on a work root stays refused …").
    expect(true).toBe(true);
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

    // Act: a start with a person behind it, then a resume whose request names a parent and a machine origin
    await subject.port.stamp({ id: FERRET, requestedByHuman: true });
    const atStart = await provenanceOf(storage);
    await subject.port.carry({ id: FERRET, parent: 'someone-else', requestedByHuman: false });
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

    // Act: the resume request does not repeat the label
    await subject.port.carry({ id: FERRET, requestedByHuman: true });

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
    await subject.port.carry({ id: FERRET, requestedByHuman: true });

    // Assert: no document was invented for it
    expect(await storage.readConfig(FERRET)).toBeUndefined();
    expect(warnings).toEqual(['a ferret has no session document yet, so its spawn stamp was not recorded']);
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
