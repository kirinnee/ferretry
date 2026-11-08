import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import { FakeRunner, harnessConformance } from '@ferretry/core-ferrets/contract/testing';
import { defineState, type FerretId } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { realClock } from '../support/ports.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';

/**
 * The Codex harness over the REAL kernel roots on a mkdtemp fixture (never a real home, never a real Codex): the home
 * `homeFor` names is made private by the kernel before anything is launched in it, a link at its name is refused, and
 * the shared harness conformance suite (S42 included) holds for this harness, not only for the fake.
 */

let fixture: string;
const AGENT_HOMES = () => join(fixture, 'fy-home/state/codex/agent-homes');
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'codex-harness-home-unit-'));
  await mkdir(join(AGENT_HOMES(), 'f2'), { recursive: true });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function build() {
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(fixture, 'fy-home'), plugin: 'codex', worktrees: join(fixture, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
  );
  const state = new Map<string, unknown>();
  const harness = codexHarness({
    kernel: {
      roots,
      state: {
        read: async (_def: unknown, name: string) => ok(state.get(name)),
        write: async (_def: unknown, value: unknown, name: string) => void state.set(name, value),
      } as never,
      log: undefined as never,
      clock: realClock(),
      redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
    },
    locate: async () => ({
      outcome: 'located',
      path: '/fixture-bin/codex',
      rule: 'inherited environment',
      declaredBy: 'PATH',
    }),
    probe: {
      version: async () => ({ state: 'ok', version: '0.145.0' }),
      startup: async () => ({ ok: true }),
    },
    update: {
      view: async () => {
        throw new Error('not used');
      },
      start: async () => {
        throw new Error('not used');
      },
      settled: async () => undefined,
    },
  });
  return { harness };
}

const spec = (ferret: string, home: string): LaunchSpec =>
  ({
    ferret,
    name: ferret,
    role: 'worker',
    harness: 'codex',
    folder: '/work/project',
    home,
    instructions: [{ plugin: 'x', id: 'i', text: 'Be brief.', when: {} }],
    parts: [],
  }) as unknown as LaunchSpec;

/** A runner that records every command it is asked to run. */
function recording() {
  const commands: RunSpec[] = [];
  const runner = {
    key: 'tmux',
    start: async (run: RunSpec) => (commands.push(run), ok({ handle: '%7', startedAt: '2026-11-01T10:00:00.000Z' })),
    resume: async (run: RunSpec) => (commands.push(run), ok({ handle: '%7', startedAt: '2026-11-01T10:00:00.000Z' })),
    stop: async () => {},
  } as unknown as Runner;
  return { runner, commands };
}

const ENV = {} as RunSpec['env'];

describe('the Codex harness over the real kernel roots', () => {
  test('S42 the home homeFor names ends 0700 before launch, a link at agent-homes/<ferret> is refused, and nothing runs', async () => {
    const { harness } = build();
    // A fresh ferret: the kernel makes its home private, and the launch runs in exactly homeFor's answer.
    const home = await harness.homeFor('fresh' as FerretId);
    expect(home).toBe(join(AGENT_HOMES(), 'fresh') as never);
    await harness.prepareHome(spec('fresh', home));
    expect((await lstat(home)).isDirectory()).toBe(true);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('Be brief.\n');
    const fresh = recording();
    expect((await harness.start(spec('fresh', home), fresh.runner, ENV)).ok).toBe(true);
    expect(fresh.commands[0]?.command.slice(0, 2)).toEqual(['env', `CODEX_HOME=${home}`]);

    // An existing home left wider by something else is narrowed before the first write.
    const f2 = await harness.homeFor('f2' as FerretId);
    await chmod(f2, 0o755);
    await harness.prepareHome(spec('f2', f2));
    expect((await lstat(f2)).mode & 0o777).toBe(0o700);

    // A link at agent-homes/<ferret>, to a sibling's home or outside: refused by prepare and by start, no write, no run.
    for (const destination of [f2, join(fixture, 'outside')]) {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'AGENTS.md'), 'other-home-fixture');
      const before = (await readdir(destination)).sort();
      const linked = join(AGENT_HOMES(), 'f3');
      await rm(linked, { force: true });
      await symlink(destination, linked);
      const f3 = spec('f3', await harness.homeFor('f3' as FerretId));
      expect(f3.home).toBe(linked as never);
      const refused = recording();
      await expect(harness.prepareHome(f3)).rejects.toThrow('root refused');
      await expect(harness.start(f3, refused.runner, ENV)).rejects.toThrow('root refused');
      expect(refused.commands).toEqual([]);
      expect((await readdir(destination)).sort()).toEqual(before);
      expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe('other-home-fixture');
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    }
  });

  test('S42 first launch on a fresh FY_HOME: the kernel made the agent-homes base 0700 at boot, the launch makes the ferret home under it', async () => {
    const fy = join(fixture, 'fy-home');
    await rm(fy, { recursive: true });
    await mkdir(fy, { mode: 0o700 });
    expect(
      await ensureInternalRootBases(
        nodeFs(() => 'fixture'),
        { home: fy, plugin: 'codex' },
        ['agent-homes', 'harness-history'],
      ),
    ).toEqual([]);
    expect((await lstat(AGENT_HOMES())).mode & 0o777).toBe(0o700);
    expect(await readdir(AGENT_HOMES())).toEqual([]);
    const { harness } = build();
    const home = await harness.homeFor('first' as FerretId);
    expect(home).toBe(join(AGENT_HOMES(), 'first') as never);
    const run = recording();
    expect((await harness.start(spec('first', home), run.runner, ENV)).ok).toBe(true);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect(await readdir(AGENT_HOMES())).toEqual(['first']);
    expect(run.commands[0]?.command.slice(0, 2)).toEqual(['env', `CODEX_HOME=${home}`]);
  });

  test('S42 first launch on a fresh FY_HOME whose kernel did not run: the harness refuses and makes no base of its own', async () => {
    const fy = join(fixture, 'fy-home');
    await rm(fy, { recursive: true });
    await mkdir(fy, { mode: 0o700 });
    const { harness } = build();
    const home = await harness.homeFor('first' as FerretId);
    const run = recording();
    await expect(harness.start(spec('first', home), run.runner, ENV)).rejects.toThrow('root refused');
    expect(run.commands).toEqual([]);
    expect(await readdir(fy)).toEqual([]);
  });
});

harnessConformance('Codex (real kernel roots)', async () => {
  const { harness } = build();
  const runner = new FakeRunner();
  return {
    harness,
    runner,
    spec: spec('f1', await harness.homeFor('f1' as FerretId)),
    // Codex sends through Conversation, so its own deliver refuses and nothing reaches the runner.
    deliveredCount: () => runner.deliveries.length,
    deliversElsewhere: true,
  };
});

// ─── skills: Skills' shared folders linked into the Codex home (kernel batch #10, owner decision !A466) ──────────────

describe('F-0006 prepareHome links the selected skills into the Codex home', () => {
  const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
  async function minted(name: string) {
    const installed = join(fixture, 'fy-home/state/skills/installed', name);
    await mkdir(installed, { recursive: true, mode: 0o700 });
    await writeFile(join(installed, 'SKILL.md'), `${name}\n`);
    const roots = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: join(fixture, 'fy-home'), plugin: 'skills', worktrees: join(fixture, 'worktrees') },
      [],
      () => undefined,
      { shareTrees: true, stateFiles: [INSTALLED], onStop: () => {} },
    );
    return await roots.share({ state: INSTALLED, name });
  }
  const exists = async (path: string) =>
    await lstat(path).then(
      () => true,
      () => false,
    );

  test('F-0006 a skill part with a shared folder is ONE link at skills/<name>, readable by Codex', async () => {
    const { harness } = build();
    const home = await harness.homeFor('f2' as FerretId);
    const tree = await minted('review');
    await harness.prepareHome({ ...spec('f2', home), parts: [{ kind: 'skill', name: 'review', tree }] } as LaunchSpec);
    const at = join(home, 'skills', 'review');
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(at, 'SKILL.md'), 'utf8')).toBe('review\n');
  });

  test('F-0006 Codex’s own skills/.system is never swept, a stale folder is, and a project skill part makes nothing', async () => {
    const { harness } = build();
    const home = await harness.homeFor('f2' as FerretId);
    await mkdir(join(home, 'skills', '.system'), { recursive: true });
    await writeFile(join(home, 'skills', '.system', 'bundled.md'), 'codex\n');
    await mkdir(join(home, 'skills', 'stale'), { recursive: true });
    const project = { kind: 'skill', name: 'local', path: '/work/.agents/skills/local' };
    await harness.prepareHome({ ...spec('f2', home), parts: [project] } as unknown as LaunchSpec);
    expect(await readFile(join(home, 'skills', '.system', 'bundled.md'), 'utf8')).toBe('codex\n');
    expect(await exists(join(home, 'skills', 'stale'))).toBe(false);
    expect(await exists(join(home, 'skills', 'local'))).toBe(false);
  });

  test('F-0006 a part named .system is skipped, never replacing Codex’s own folder', async () => {
    const { harness } = build();
    const home = await harness.homeFor('f2' as FerretId);
    await mkdir(join(home, 'skills', '.system'), { recursive: true });
    await writeFile(join(home, 'skills', '.system', 'bundled.md'), 'codex\n');
    const tree = await minted('review');
    await harness.prepareHome({ ...spec('f2', home), parts: [{ kind: 'skill', name: '.system', tree }] } as LaunchSpec);
    expect(await readFile(join(home, 'skills', '.system', 'bundled.md'), 'utf8')).toBe('codex\n');
  });
});
