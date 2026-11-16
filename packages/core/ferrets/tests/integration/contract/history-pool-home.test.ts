import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FencedPath, FerretId, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { defineState } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost, type TestHost } from '@ferretry/kernel/testing';
import { nodeFs } from '../../../../kernel/host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../kernel/host/roots.ts';
import { poolHomeHistory } from '../../../contract/history-pool-home.ts';

const POOL = defineState({ name: 'pool', path: 'history-pool/*', store: 'opaque', format: 1 });
const ferret = 'f1' as FerretId;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const path = (root: RootHandle, relative: string): FencedPath => {
  const result = root.resolve(relative);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

for (const backend of ['real', 'testing'] as const) {
  for (const entry of ['projects', 'sessions'] as const) {
    const entries = [{ name: entry, kind: 'folder' as const }];
    const permission = { state: POOL.name, entries };
    async function world() {
      let roots!: RootsPort;
      let host: TestHost | undefined;
      if (backend === 'real') {
        const parent = await mkdtemp(join(tmpdir(), 'pool-home-preflight-'));
        parents.push(parent);
        const home = join(parent, 'fy');
        for (const folder of ['', 'state', 'state/harness']) {
          await mkdir(join(home, folder), { recursive: true, mode: 0o700 });
          await chmod(join(home, folder), 0o700);
        }
        const fs = nodeFs(() => crypto.randomUUID());
        await ensureInternalRootBases(fs, { home, plugin: 'harness' }, ['agent-homes'], {
          historyPool: permission,
          stateFiles: [POOL],
        });
        roots = rootsPortFor(
          fs,
          { home, plugin: 'harness', worktrees: join(home, 'worktrees') },
          ['agent-homes'],
          () => undefined,
          {
            historyPool: permission,
            stateFiles: [POOL],
          },
        );
      } else {
        const manifest = definePlugin({
          id: 'harness',
          title: 'Harness',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          permissions: { roots: ['agent-homes'], historyPool: permission },
          data: { state: [POOL] },
        });
        host = await testHost({
          plugins: [
            implementDaemon(manifest, {
              build: ctx => {
                roots = ctx.kernel.roots;
                return {};
              },
            }),
          ],
        });
      }
      const home = roots!.root('agent-homes', { ferret, subfolder: ferret });
      await home.makeDirectory(path(home, `${entry}/slug`));
      await home.writeText(path(home, `${entry}/slug/a.jsonl`), 'keep my conversation');
      const pool = roots!.historyPool();
      await pool.makeDirectory(path(pool, `${entry}/slug`));
      return {
        roots,
        home,
        pool,
        hardLink: async () => {
          const relative = `${entry}/slug/z-hard`;
          if (host !== undefined) host.putRootHardLink('agent-homes', `f1/${relative}`, 'hard-linked');
          else {
            await writeFile(path(home, relative), 'hard-linked');
            await link(path(home, relative), path(home, 'other-name'));
          }
        },
        staleLink: async () => {
          const relative = `${entry}/slug/z-stale`;
          if (host !== undefined) host.putRootLink('agent-homes', `f1/${relative}`);
          else await symlink('/missing-history-target', path(home, relative));
        },
      };
    }

    describe(`${backend} ${entry} preflight`, () => {
      for (const problem of ['hard link', 'stale link'] as const) {
        test(`a nested ${problem} refuses before any earlier transcript moves`, async () => {
          const w = await world();
          if (problem === 'hard link') await w.hardLink();
          else await w.staleLink();
          const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
          expect(result.moved).toBe(0);
          expect(result.sentence).toContain(problem === 'hard link' ? 'hard_link' : 'link_escape');
          expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
          expect(await w.pool.lstat(path(w.pool, `${entry}/slug/a.jsonl`))).toBeUndefined();
          expect((await w.home.lstat(path(w.home, entry)))?.kind).toBe('directory');
        });
      }

      test('real backup and rollout names containing @ and spaces are accepted', async () => {
        const w = await world();
        for (const name of ['84b727d6c7b7f7d4@v1', 'rollout with space.jsonl'])
          await w.home.writeText(path(w.home, `${entry}/slug/${name}`), name);
        const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
        expect(result.sentence).toBeUndefined();
        expect(result.moved).toBe(3);
        for (const name of ['84b727d6c7b7f7d4@v1', 'rollout with space.jsonl'])
          expect(await w.pool.readText(path(w.pool, `${entry}/slug/${name}`))).toBe(name);
      });

      test('a concurrent target winner is retained and the source goes to a free conflict name', async () => {
        const w = await world();
        let raced = false;
        const moving: RootHandle = {
          ...w.home,
          moveToHistoryPool: async (from, pool, to) => {
            if (!raced) {
              raced = true;
              await pool.writeText(to, 'concurrent winner', { exclusive: true });
              await pool.makeDirectory(path(pool, `.conflicts/f1/${entry}/slug`));
              await pool.writeText(path(pool, `.conflicts/f1/${entry}/slug/a.jsonl`), 'older conflict');
            }
            await w.home.moveToHistoryPool(from, pool, to);
          },
        };
        const result = await poolHomeHistory({
          roots: { root: () => moving, historyPool: () => w.pool },
          ferret,
          entries,
        });
        expect(result.sentence).toBeUndefined();
        expect(result.moved).toBe(1);
        expect(result.conflicts).toEqual([`.conflicts/f1/${entry}/slug/a.jsonl.2`]);
        expect(await w.pool.readText(path(w.pool, `${entry}/slug/a.jsonl`))).toBe('concurrent winner');
        expect(await w.pool.readText(path(w.pool, `.conflicts/f1/${entry}/slug/a.jsonl`))).toBe('older conflict');
        expect(await w.pool.readText(path(w.pool, `.conflicts/f1/${entry}/slug/a.jsonl.2`))).toBe(
          'keep my conversation',
        );
      });

      test('a partial merge refuses this launch and failed retries until a retry links the completed entry', async () => {
        const w = await world();
        await w.home.writeText(path(w.home, `${entry}/slug/b.jsonl`), 'second conversation');
        let calls = 0;
        let fail = true;
        const moving: RootHandle = {
          ...w.home,
          moveToHistoryPool: async (from, pool, to) => {
            calls += 1;
            if (fail && calls >= 2) throw Object.assign(new Error('disk refused'), { refusal: 'changed' });
            await w.home.moveToHistoryPool(from, pool, to);
          },
        };
        const roots = { root: () => moving, historyPool: () => w.pool };
        const run = () => poolHomeHistory({ roots, ferret, entries });
        await expect(run()).rejects.toThrow('stopped part-way');
        expect(await w.pool.readText(path(w.pool, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
        expect(await w.home.readText(path(w.home, `${entry}/slug/b.jsonl`))).toBe('second conversation');
        expect((await w.home.lstat(path(w.home, `.history-pool-pending-${entry}`)))?.kind).toBe('file');
        // This retry moves nothing new, but must not launch unpooled after the earlier move.
        await expect(run()).rejects.toThrow('stopped part-way');
        await expect(
          poolHomeHistory({
            roots: {
              root: () => moving,
              historyPool: () => {
                throw new Error('pool unavailable');
              },
            },
            ferret,
            entries,
          }),
        ).rejects.toThrow('stopped part-way');
        fail = false;
        const retried = await run();
        expect(retried.sentence).toBeUndefined();
        expect(retried.linked).toEqual([entry]);
        expect(await w.pool.readText(path(w.pool, `${entry}/slug/b.jsonl`))).toBe('second conversation');
        expect((await w.home.lstat(path(w.home, entry)))?.kind).toBe('symlink');
        expect(await w.home.lstat(path(w.home, `.history-pool-pending-${entry}`))).toBeUndefined();
      });

      test('an uncertain first move refuses the launch when the syscall landed before the error', async () => {
        const w = await world();
        let fail = true;
        const moving: RootHandle = {
          ...w.home,
          moveToHistoryPool: async (from, pool, to) => {
            await w.home.moveToHistoryPool(from, pool, to);
            if (fail) {
              fail = false;
              throw new Error('post-move proof failed');
            }
          },
        };
        const roots = { root: () => moving, historyPool: () => w.pool };
        await expect(poolHomeHistory({ roots, ferret, entries })).rejects.toThrow('stopped part-way');
        expect((await w.home.lstat(path(w.home, `.history-pool-pending-${entry}`)))?.kind).toBe('file');
        const result = await poolHomeHistory({ roots, ferret, entries });
        expect(result.sentence).toBeUndefined();
        expect(result.linked).toEqual([entry]);
        expect(await w.pool.readText(path(w.pool, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
      });

      test('a first-move no-descriptor refusal launches unpooled with the original transcript and no pending marker', async () => {
        const w = await world();
        const moving: RootHandle = {
          ...w.home,
          moveToHistoryPool: async () => {
            throw Object.assign(new Error('unsupported'), { refusal: 'no_descriptor_reach' });
          },
        };
        const result = await poolHomeHistory({
          roots: { root: () => moving, historyPool: () => w.pool },
          ferret,
          entries,
        });
        expect(result.moved).toBe(0);
        expect(result.sentence).toContain('this computer cannot link shared history yet');
        expect(result.linked).toEqual([]);
        expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
        expect(await w.home.lstat(path(w.home, `.history-pool-pending-${entry}`))).toBeUndefined();
      });

      test('an existing pool entry of the wrong kind refuses before any local transcript moves', async () => {
        const w = await world();
        await w.pool.remove(path(w.pool, entry));
        await w.pool.writeText(path(w.pool, entry), 'wrong pool entry kind');
        const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
        expect(result.moved).toBe(0);
        expect(result.linked).toEqual([]);
        expect(result.sentence).toContain('changed');
        expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
        expect(await w.pool.readText(path(w.pool, entry))).toBe('wrong pool entry kind');
        expect(await w.home.lstat(path(w.home, `.history-pool-pending-${entry}`))).toBeUndefined();
      });

      test('the move limit is checked for the complete entry before the first transcript moves', async () => {
        const w = await world();
        const original = await w.home.lstat(path(w.home, `${entry}/slug/a.jsonl`));
        const wide: RootHandle = {
          ...w.home,
          list: async at =>
            at === path(w.home, `${entry}/slug`)
              ? ['a.jsonl', ...Array.from({ length: 20_000 }, (_, n) => `z-${n}.jsonl`)]
              : await w.home.list(at),
          lstat: async at => (String(at).includes('/z-') ? original : await w.home.lstat(at)),
        };
        const roots = { root: () => wide, historyPool: () => w.pool };
        const result = await poolHomeHistory({ roots, ferret, entries });
        expect(result.moved).toBe(0);
        expect(result.linked).toEqual([]);
        expect(result.sentence).toContain('too_many');
        expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
        expect(await w.pool.lstat(path(w.pool, `${entry}/slug/a.jsonl`))).toBeUndefined();
      });

      test('a refused name after a valid transcript leaves every source in place', async () => {
        const w = await world();
        await w.home.writeText(path(w.home, `${entry}/slug/.stale`), 'not a pooled name');
        const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
        expect(result.moved).toBe(0);
        expect(result.sentence).toContain('denied');
        expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
        expect(await w.pool.lstat(path(w.pool, `${entry}/slug/a.jsonl`))).toBeUndefined();
      });

      test('a depth refusal leaves earlier transcripts untouched', async () => {
        const w = await world();
        await w.home.makeDirectory(path(w.home, `${entry}/z/${Array.from({ length: 12 }, () => 'deep').join('/')}`));
        const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
        expect(result.moved).toBe(0);
        expect(result.sentence).toContain('too_many');
        expect(await w.home.readText(path(w.home, `${entry}/slug/a.jsonl`))).toBe('keep my conversation');
      });

      test('an empty nested directory is preserved without moving a folder', async () => {
        const w = await world();
        await w.home.makeDirectory(path(w.home, `${entry}/empty/inside`));
        const result = await poolHomeHistory({ roots: w.roots, ferret, entries });
        expect(result.sentence).toBeUndefined();
        expect(result.moved).toBe(1);
        expect((await w.pool.lstat(path(w.pool, `${entry}/empty/inside`)))?.kind).toBe('directory');
        expect((await w.home.lstat(path(w.home, entry)))?.kind).toBe('symlink');
      });
    });
  }
}

test('a home-root or home-path refusal goes on unpooled with one sentence', async () => {
  const failed = () => {
    throw new Error('unavailable');
  };
  for (const roots of [
    { root: failed, historyPool: failed },
    { root: () => ({ resolve: failed }) as unknown as RootHandle, historyPool: failed },
  ]) {
    const result = await poolHomeHistory({ roots, ferret, entries: [{ name: 'projects', kind: 'folder' }] });
    expect(result.moved).toBe(0);
    expect(result.linked).toEqual([]);
    expect(result.sentence).toContain('goes on with its own history');
  }
});
