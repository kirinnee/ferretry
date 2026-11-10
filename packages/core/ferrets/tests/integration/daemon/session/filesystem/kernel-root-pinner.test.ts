import { describe, expect, test } from 'bun:test';
import type { FencedPath, FolderRefusal, HeldRoot, PinOptions, ScratchDirectory } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { KernelDiffScratch } from '../../../../../daemon/adapters/session/filesystem/kernel-diff-scratch.ts';
import {
  KernelSessionRootPinner,
  type PinnableRoot,
} from '../../../../../daemon/adapters/session/filesystem/kernel-root-pinner.ts';
import { SYMLINK_MODE } from '../../../../../daemon/adapters/session/filesystem/runner-session-git.ts';
import { FsError } from '../../../../../daemon/lib/session/filesystem/index.ts';

/** A kernel error as the host raises it: named, and carrying the refusal word. */
const rootError = (refusal: string): Error =>
  Object.assign(new Error(`root refused: ${refusal}`), { name: 'RootError', refusal });

interface Seen {
  readonly resolved: string[];
  readonly pinned: { path: string; options: PinOptions | undefined }[];
}

function root(options: { readonly resolve?: FolderRefusal; readonly pin?: Error }): {
  readonly root: PinnableRoot;
  readonly seen: Seen;
} {
  const seen: Seen = { resolved: [], pinned: [] };
  const held = { rootReal: '/work/a', close: async () => undefined } as unknown as HeldRoot;
  return {
    seen,
    root: {
      resolve: relative => {
        seen.resolved.push(relative);
        return options.resolve === undefined ? ok(`/work/${relative}` as FencedPath) : err(options.resolve);
      },
      pin: async (path, pinOptions) => {
        seen.pinned.push({ path, options: pinOptions });
        if (options.pin !== undefined) throw options.pin;
        return held;
      },
    },
  };
}

describe('the session root pinner over the ferret’s work root', () => {
  test('S47 it holds the work root itself open, whatever folder name the session document carried', async () => {
    const { root: fake, seen } = root({});
    const pinned = await new KernelSessionRootPinner(fake).pin('/etc');
    expect(pinned.rootReal).toBe('/work/a');
    // The string from the document is never resolved, opened or pinned: the root names where the pin lands.
    expect(seen.resolved).toEqual(['.']);
    expect(seen.pinned.map(call => call.path)).toEqual(['/work/.']);
  });

  test('S47 the caller’s refusal rule travels to the pin’s one chokepoint', async () => {
    const { root: fake, seen } = root({});
    const refuseRoot = (real: string): boolean => real === '/home';
    await new KernelSessionRootPinner(fake).pin('/work/a', { refuseRoot });
    expect(seen.pinned[0]?.options?.refuseRoot).toBe(refuseRoot);
  });

  test('S47 a root the lexical check refuses is never pinned', async () => {
    for (const [refusal, code] of [
      ['fenced', 'denied'],
      ['outside', 'escapes_root'],
      ['unknown_ferret', 'not_found'],
    ] as const) {
      const { root: fake, seen } = root({ resolve: refusal });
      const error = await new KernelSessionRootPinner(fake).pin('/work/a').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FsError);
      expect((error as FsError).code).toBe(code);
      expect(seen.pinned).toEqual([]);
    }
  });

  test('S47 each refusal of the held object is said in the viewer’s own words, and an object swapped out is an escape', async () => {
    const expected: Readonly<Record<string, string>> = {
      fenced: 'denied',
      link_escape: 'escapes_root',
      changed: 'escapes_root',
      hard_link: 'escapes_root',
      outside: 'escapes_root',
      unknown_ferret: 'not_found',
      device_file: 'not_a_directory',
      not_a_file: 'not_a_directory',
      not_declared: 'unsupported',
      read_only: 'unsupported',
      no_descriptor_reach: 'unsupported',
    };
    for (const [refusal, code] of Object.entries(expected)) {
      const { root: fake } = root({ pin: rootError(refusal) });
      const error = await new KernelSessionRootPinner(fake).pin('/work/a').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FsError);
      expect([refusal, (error as FsError).code]).toEqual([refusal, code]);
    }
  });

  test('S47 a folder that is gone, or no longer a folder, is a clean refusal; a failure it does not know is not softened', async () => {
    const gone = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const file = Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    const broken = new Error('disk on fire');
    const run = async (failure: Error) =>
      await new KernelSessionRootPinner(root({ pin: failure }).root).pin('/work/a').catch((e: unknown) => e);
    expect(((await run(gone)) as FsError).code).toBe('not_found');
    expect(((await run(file)) as FsError).code).toBe('not_a_directory');
    expect(await run(broken)).toBe(broken);
  });
});

describe('a walk beneath the held root that the kernel’s fence refuses', () => {
  const walking = (failure: Error) => {
    const held = {
      rootReal: '/work/a',
      open: async () => {
        throw failure;
      },
      probe: () => 'the probe',
      close: async () => undefined,
    } as unknown as HeldRoot;
    return new KernelSessionRootPinner({ resolve: () => ok('/work/.' as FencedPath), pin: async () => held });
  };

  test('S47 a path inside the state home, or a file that could be named in it, is the viewer’s denied (403)', async () => {
    for (const refusal of ['fenced', 'hard_link']) {
      const pinned = await walking(rootError(refusal)).pin('/work/a');
      const error = await pinned.open('.ferretry/secret.json').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FsError);
      expect((error as FsError).code).toBe('denied');
    }
  });

  test('S47 any other failure of the walk is raised as it is, and the rest of the held root is handed through', async () => {
    const broken = new Error('disk on fire');
    const pinned = await walking(broken).pin('/work/a');
    expect(await pinned.open('a.txt').catch((e: unknown) => e)).toBe(broken);
    expect(pinned.rootReal).toBe('/work/a');
    expect(pinned.probe()).toBe('the probe' as never);
  });
});

describe('the diff scratch over the kernel’s scratch folder', () => {
  function scratch() {
    const log: string[] = [];
    let closed = false;
    const directory: ScratchDirectory = {
      path: '/scratch/1' as FencedPath,
      makeDirectory: async rel => void log.push(`mkdir ${rel}`),
      writeFile: async (rel, data, mode) =>
        void log.push(`file ${rel} ${String(mode?.toString(8))} ${String(data.length)}`),
      symlink: async (rel, target) => void log.push(`link ${rel} -> ${target}`),
      close: async () => {
        closed = true;
      },
    };
    return { port: { open: async () => directory }, log, closed: () => closed };
  }

  test('S47 a side is staged with exactly its permission bits and a link is made, not followed; the folder is always removed', async () => {
    const s = scratch();
    const bytes = new TextEncoder().encode('x');
    await new KernelDiffScratch(s.port).withScratch(async (directory, stage) => {
      expect(directory).toBe('/scratch/1');
      await stage('a/b.txt', { bytes, mode: 0o100755 });
      await stage('l', { bytes: new TextEncoder().encode('target'), mode: SYMLINK_MODE });
    });
    expect(s.log).toEqual(['mkdir a', 'file a/b.txt 755 1', 'link l -> target']);
    expect(s.closed()).toBe(true);
  });

  test('S47 the scratch folder is removed when the work fails', async () => {
    const s = scratch();
    await expect(
      new KernelDiffScratch(s.port).withScratch(async () => {
        throw new Error('git failed');
      }),
    ).rejects.toThrow('git failed');
    expect(s.closed()).toBe(true);
  });
});
