/**
 * G162, the raw-byte handle over the kernel's REAL fenced roots and a REAL folder (security review of 4525fc1c36, P1-2 and
 * P1-3): the handle is bound to ONE opened object, so no swap, restore, symlink or reused inode number can make it answer
 * another file's bytes or metadata. Nothing here is a mock of the filesystem or the root; the races are scheduled by
 * wrapping the held descriptor's own calls and doing real renames around the real IO.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, RootHandle, RootOpenedBytes } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import { HarnessTranscriptReplaced } from '../../contract/index.ts';
import { openTranscriptBytes, type TranscriptBytesRoot } from '../../contract/transcript-bytes.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-bytes-disk-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const folder = join(home, 'state', 'codex', 'agent-homes', 'f1', 'sessions');
  await mkdir(folder, { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes'],
    () => undefined,
    { hardLinkRoots: [] },
  );
  const root = roots.root('agent-homes', { subfolder: 'f1/sessions' });
  const resolved = root.resolve('rollout-a.jsonl');
  if (!resolved.ok) throw new Error('fixture path');
  const target = join(folder, 'rollout-a.jsonl');
  const other = join(folder, 'foreign.txt');
  return { parent, folder, root, file: resolved.value as FencedPath, target, other };
}

/** A root whose held descriptor runs `around` the real call: the swap is scheduled exactly there. */
function scheduled(
  root: RootHandle,
  around: {
    read?: (real: () => Promise<Uint8Array>) => Promise<Uint8Array>;
    stat?: (real: () => Promise<{ size: number; mtimeMs: number }>) => Promise<{ size: number; mtimeMs: number }>;
  },
): TranscriptBytesRoot {
  return {
    openBytes: async file => {
      const opened = await root.openBytes!(file);
      if (opened === undefined) return undefined;
      const wrapped: RootOpenedBytes = {
        identity: opened.identity,
        birthNs: opened.birthNs,
        read: async (offset, length) =>
          around.read === undefined
            ? await opened.read(offset, length)
            : await around.read(() => opened.read(offset, length)),
        stat: async () => (around.stat === undefined ? await opened.stat() : await around.stat(() => opened.stat())),
        stillNames: () => opened.stillNames(),
        close: () => opened.close(),
      };
      return wrapped;
    },
  };
}

/** How many descriptors this process holds (Linux): the leak checks compare it before and after. */
const descriptors = async (): Promise<number | undefined> =>
  await readdir('/proc/self/fd').then(
    names => names.length,
    () => undefined,
  );

describe('G162 the byte handle is bound to ONE opened object', () => {
  test('it reads, stats and tokens the opened file, with the same token for every handle on one generation', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED-BYTES');
    const first = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    const second = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    expect(decode(await first.read(0, 6))).toBe('PROVED');
    expect(decode(await first.read(6, 100))).toBe('-BYTES');
    expect(await first.stat()).toEqual({ size: 12, mtimeMs: first.mtimeMs });
    expect(first.file).toBe(second.file);
    expect(first.file).toHaveLength(22);
    await first.close();
    await second.close();
  });

  test('a file replaced between two reads rejects, and a new handle on the replacement has another token', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    await writeFile(`${w.target}.new`, 'REPLACEMENT');
    await rename(`${w.target}.new`, w.target);
    await expect(handle.read(0, 100)).rejects.toBeInstanceOf(HarnessTranscriptReplaced);
    expect(await handle.stat()).toBeUndefined();
    const next = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    expect(next.file).not.toBe(handle.file);
    await handle.close();
    await next.close();
  });

  for (const link of [false, true]) {
    describe(link ? 'an in-root symlink to an unproved file' : 'an unproved regular file', () => {
      test('swapped in DURING the read and left there: the read rejects', async () => {
        const w = await world();
        await writeFile(w.target, 'PROVED');
        await writeFile(w.other, 'UNPROVED');
        const root = scheduled(w.root, {
          read: async real => {
            await rename(w.target, `${w.target}.saved`);
            if (link) await symlink(w.other, w.target);
            else await rename(w.other, w.target);
            return await real();
          },
        });
        const handle = (await openTranscriptBytes(root, w.file, 'codex', digest))!;
        expect(await handle.read(0, 100).then(decode, error => error)).toBeInstanceOf(HarnessTranscriptReplaced);
        await handle.close();
      });

      test('swapped in during the read and RESTORED before the post-check: the bytes are the proved object’s, never the unproved ones', async () => {
        const w = await world();
        await writeFile(w.target, 'PROVED');
        await writeFile(w.other, 'UNPROVED');
        const root = scheduled(w.root, {
          read: async real => {
            await rename(w.target, `${w.target}.saved`);
            if (link) await symlink(w.other, w.target);
            else await rename(w.other, w.target);
            try {
              return await real();
            } finally {
              if (link) await rm(w.target);
              else await rename(w.target, w.other);
              await rename(`${w.target}.saved`, w.target);
            }
          },
        });
        const handle = (await openTranscriptBytes(root, w.file, 'codex', digest))!;
        const result = await handle.read(0, 100).then(decode, error => error);
        // The read went through the held descriptor: whatever the name reached meanwhile, these are not its bytes.
        expect(result).toBe('PROVED');
        await handle.close();
      });
    });
  }

  test('a replacement inserted between the name check and the stat is never reported as the proved file’s metadata', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    await writeFile(`${w.target}.new`, 'UNPROVED-LONGER');
    const root = scheduled(w.root, {
      stat: async real => {
        if (armed) await rename(`${w.target}.new`, w.target);
        return await real();
      },
    });
    let armed = false;
    const handle = (await openTranscriptBytes(root, w.file, 'codex', digest))!;
    armed = true;
    expect(await handle.stat()).toBeUndefined();
    await handle.close();
  });

  test('a link at the name is refused at the open, even to a file inside the root', async () => {
    const w = await world();
    await writeFile(w.other, 'UNPROVED');
    await symlink(w.other, w.target);
    expect(await openTranscriptBytes(w.root, w.file, 'codex', digest)).toBeUndefined();
  });

  for (const link of [false, true]) {
    test(`a removed and recreated ${link ? 'symlink' : 'file'} cannot take over the held inode, so the old handle rejects`, async () => {
      const w = await world();
      await writeFile(w.target, 'PROVED');
      const before = await lstat(w.target, { bigint: true });
      const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
      await writeFile(w.other, 'SYMLINK-UNPROVED');
      for (let n = 0; n < 256; n++) {
        await rm(w.target);
        if (link) await symlink(w.other, w.target);
        else await writeFile(w.target, `RECREATED-${n}`);
        const now = await lstat(w.target, { bigint: true });
        // The open descriptor pins the inode: the allocator cannot hand its number out again while the handle is open.
        expect(now.ino === before.ino && now.dev === before.dev).toBe(false);
      }
      expect(await handle.read(0, 100).then(decode, error => error)).toBeInstanceOf(HarnessTranscriptReplaced);
      await handle.close();
    });
  }

  test('a file recreated under a REUSED inode number, after the old handle closed, is another generation with another token', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    const before = await lstat(w.target, { bigint: true });
    const old = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    const oldToken = old.file;
    await old.close();
    let reused = false;
    for (let n = 0; n < 2048 && !reused; n++) {
      await rm(w.target);
      await writeFile(w.target, `RECREATED-${n}`);
      const now = await lstat(w.target, { bigint: true });
      reused = now.dev === before.dev && now.ino === before.ino;
    }
    const next = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    // Whether or not this filesystem handed the number out again, a new generation never shares the old one's token.
    expect(next.file).not.toBe(oldToken);
    await next.close();
  });

  test('a token is a digest of the path and the object’s identity: the same identity and birth give the same token, another birth another', async () => {
    const seen: string[] = [];
    const opened = (birthNs: bigint | undefined): RootOpenedBytes => ({
      identity: { device: 1n, inode: 2n },
      birthNs,
      read: async () => new Uint8Array(0),
      stat: async () => ({ size: 0, mtimeMs: 0 }),
      stillNames: async () => true,
      close: async () => undefined,
    });
    const tokenOf = async (birthNs: bigint | undefined): Promise<string> => {
      const handle = (await openTranscriptBytes(
        { openBytes: async () => opened(birthNs) },
        'x' as FencedPath,
        'claude',
        text => {
          seen.push(text);
          return digest(text);
        },
      ))!;
      await handle.close();
      return handle.file;
    };
    expect(await tokenOf(5n)).toBe(await tokenOf(5n));
    expect(await tokenOf(5n)).not.toBe(await tokenOf(6n));
    expect(seen.length).toBe(4);
  });

  test('a root that offers no held open yields no handle', async () => {
    expect(await openTranscriptBytes({}, 'x' as FencedPath, 'claude', digest)).toBeUndefined();
  });
});

describe('G162 the handle is closable and bounded', () => {
  test('open and close leaves no descriptor behind, close is idempotent, and a read after it fails without the path', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    const base = await descriptors();
    for (let n = 0; n < 40; n++) {
      const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
      await handle.read(0, 4);
      await handle.close();
      await handle.close();
    }
    const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    await handle.close();
    const failure = await handle.read(0, 4).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(HarnessTranscriptReplaced);
    expect(`${(failure as Error).message}${(failure as Error).stack ?? ''}`).not.toContain('rollout-a');
    expect(await handle.stat()).toBeUndefined();
    if (base !== undefined) expect(await descriptors()).toBe(base);
  });

  /** The kernel clock's `after`, driven by hand: a timer is live until it fires or is cancelled. */
  const manualClock = () => {
    const timers: { fn: () => void; live: boolean; delay: number }[] = [];
    return {
      timers,
      live: () => timers.filter(timer => timer.live),
      clock: {
        after: (delay: unknown, fn: () => void) => {
          const timer = { fn, live: true, delay: Number(delay) };
          timers.push(timer);
          return () => {
            timer.live = false;
          };
        },
      },
      /** Fires every live timer, as the idle time passing would. */
      elapse: () => {
        for (const timer of timers.filter(each => each.live)) {
          timer.live = false;
          timer.fn();
        }
      },
    };
  };

  test('a handle nobody closes lets its descriptor go when its idle time passes', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    const base = await descriptors();
    const time = manualClock();
    const handles = await Promise.all(
      Array.from(
        { length: 10 },
        async () => (await openTranscriptBytes(w.root, w.file, 'codex', digest, { clock: time.clock, idleMs: 25 }))!,
      ),
    );
    expect(time.live()).toHaveLength(10);
    expect(time.live()[0]?.delay).toBe(25);
    if (base !== undefined) expect(await descriptors()).toBeGreaterThan(base);
    time.elapse();
    // The timer's close is in flight: closing again waits for it.
    await Promise.all(handles.map(async handle => await handle.close()));
    if (base !== undefined) expect(await descriptors()).toBe(base);
    await expect(handles[0]!.read(0, 4)).rejects.toThrow('closed');
  });

  test('every use renews the idle time (one live timer, always), and close cancels it', async () => {
    const w = await world();
    await writeFile(w.target, 'PROVED');
    const time = manualClock();
    const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest, { clock: time.clock, idleMs: 120 }))!;
    expect(time.live()).toHaveLength(1);
    for (let n = 0; n < 4; n++) {
      expect(decode(await handle.read(0, 6))).toBe('PROVED');
      await handle.stat();
      expect(time.live()).toHaveLength(1);
    }
    expect(time.timers.length).toBeGreaterThan(5);
    await handle.close();
    expect(time.live()).toHaveLength(0);
  });
});

describe('G162 the window rules and the path-free errors hold', () => {
  test('offset and length bounds, clamping, EOF and no path in a field or an error', async () => {
    const w = await world();
    await writeFile(w.target, '0123456789');
    const handle = (await openTranscriptBytes(w.root, w.file, 'codex', digest))!;
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      await expect(handle.read(bad, 1)).rejects.toBeInstanceOf(RangeError);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(handle.read(0, bad)).rejects.toBeInstanceOf(RangeError);
    expect(decode(await handle.read(8, 100))).toBe('89');
    expect(await handle.read(100, 4)).toHaveLength(0);
    expect(await handle.read(0, 0)).toHaveLength(0);
    const shown = JSON.stringify(
      Object.fromEntries(Object.entries(handle).filter(([, value]) => typeof value !== 'function')),
    );
    for (const secret of [w.parent, 'rollout-a', 'agent-homes', 'sessions']) expect(shown).not.toContain(secret);
    await rm(w.target);
    const gone = await handle.read(0, 4).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(HarnessTranscriptReplaced);
    expect(`${(gone as Error).message}${(gone as Error).stack ?? ''}`).not.toContain(w.parent);
    await handle.close();
  });
});
