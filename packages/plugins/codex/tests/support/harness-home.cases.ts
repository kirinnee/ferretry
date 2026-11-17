import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import { FakeRunner, harnessConformance } from '@ferretry/core-ferrets/contract/testing';
import { defineState, type FerretId, type SharedCredential } from '@ferretry/kernel/contract';
import { buildSnapshot } from '@ferretry/kernel/host';
import { ok } from '@ferretry/std';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { CODEX_SETTINGS } from '../../contract/index.ts';
import { realClock } from './ports.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { selectEverything, selectSettings } from './selected.ts';

/** ONE body, registered by two tiers: `lib/settings.ts` (unit ledger) and the harness adapter (integration ledger). */
export function harnessHomeCases(): void {
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

  function build(
    items: ReadonlyMap<string, unknown> = new Map(),
    options: {
      readonly withoutConfig?: boolean;
      readonly warned?: string[];
      readonly selected?: Parameters<typeof codexHarness>[0]['selected'];
    } = {},
  ) {
    const roots = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: join(fixture, 'fy-home'), plugin: 'codex', worktrees: join(fixture, 'worktrees') },
      ['agent-homes', 'harness-history'],
      () => undefined,
    );
    const state = new Map<string, unknown>();
    const harness = codexHarness({
      selected: options.selected ?? selectEverything,
      kernel: {
        roots,
        state: {
          read: async (_def: unknown, name: string) => ok(state.get(name)),
          write: async (_def: unknown, value: unknown, name: string) => void state.set(name, value),
        } as never,
        log: (options.warned === undefined
          ? undefined
          : { warn: (message: string) => options.warned?.push(message) }) as never,
        clock: realClock(),
        redaction: { read: async fn => await fn({ text: (s: string) => s } as never) },
        ...(options.withoutConfig === true
          ? {}
          : {
              config: {
                collection: (definition: unknown) => (definition === CODEX_SETTINGS ? items : new Map()),
              } as never,
            }),
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

  describe('the AGENTS.md a launch writes carries the job keeper words (F4316)', () => {
    // The ACTIVE path: a manifest `instructions` entry -> the kernel snapshot (text read from the real
    // `instructions/jobs.md`) -> the launch's instruction list -> the file Codex reads. Terminals' own unit test pins the
    // declaration; this builds the real Codex home from it for auto and interactive ferrets, lead and helper.
    const JOBS_FILE = join(import.meta.dir, '../../../terminals/instructions/jobs.md');
    const snapshot = buildSnapshot(
      [
        {
          id: 'terminals',
          instructions: [{ id: 'jobs', text: 'instructions/jobs.md', when: { role: 'any' } }],
        } as never,
      ],
      [],
      () => readFileSync(JOBS_FILE, 'utf8'),
    );
    const JOBS = readFileSync(JOBS_FILE, 'utf8').trim();

    for (const mode of ['auto', 'interactive'] as const)
      for (const role of ['lead', 'helper'] as const)
        test(`a ${mode} ${role} reads them`, async () => {
          const { harness } = build();
          const home = await harness.homeFor('f2' as FerretId);
          const instructions = snapshot.instructions.filter(
            entry => entry.when.role === undefined || entry.when.role === 'any' || entry.when.role === role,
          );
          await harness.prepareHome({ ...spec('f2', home), role, mode, instructions } as unknown as LaunchSpec);
          const agents = await readFile(join(home, 'AGENTS.md'), 'utf8');
          expect(agents).toContain(JOBS);
          expect(agents).toContain('Codex: exec_command with a short yield_time_ms');
        });
  });

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

    test('a settings item with shell_environment_policy.set reaches the Codex config.toml, and a secret stays the reference it is written as', async () => {
      const { harness } = build(
        new Map([
          [
            'guard',
            {
              settings: {
                model: 'gpt-5',
                shell_environment_policy: { inherit: 'core', set: { LOG: '1', GUARD: '${secret:GUARD_VALUE}' } },
              },
            },
          ],
        ]),
      );
      const home = await harness.homeFor('f2' as FerretId);

      await harness.prepareHome(spec('f2', home));

      const config = await readFile(join(home, 'config.toml'), 'utf8');
      expect(config).toBe(
        [
          'check_for_update_on_startup = false',
          'model = "gpt-5"',
          '',
          '[shell_environment_policy]',
          'inherit = "core"',
          '',
          '[shell_environment_policy.set]',
          'LOG = "1"',
          'GUARD = "${secret:GUARD_VALUE}"',
          '',
        ].join('\n'),
      );
    });

    test('B02 only the settings items the launching runtime’s profile selects reach its home; the rest stay out', async () => {
      const items = new Map<string, unknown>([
        ['guard', { settings: { model: 'gpt-5' } }],
        ['other', { settings: { shell_environment_policy: { set: { OTHER: '1' } } } }],
      ]);
      const home = await build(items).harness.homeFor('f2' as FerretId);

      // The runtime's profile names `settings/guard` only: `other` (another profile's) is not in its home.
      await build(items, { selected: selectSettings('guard') }).harness.prepareHome({
        ...spec('f2', home),
        runtime: 'work',
      } as LaunchSpec);
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(
        'check_for_update_on_startup = false\nmodel = "gpt-5"\n',
      );

      // A profile that names no settings component gets none: only Ferretry's own default is in its config.toml.
      await build(items, { selected: selectSettings() }).harness.prepareHome({
        ...spec('f2', home),
        runtime: 'bare',
      } as LaunchSpec);
      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('check_for_update_on_startup = false\n');
    });

    test('settings items merge in name order (the later wins), beside the MCP servers a launch adds, and a launch server replaces a settings one', async () => {
      const { harness } = build(
        new Map([
          [
            'a-base',
            {
              settings: {
                shell_environment_policy: { set: { LOG: '1', KEEP: 'yes' } },
                mcp_servers: { docs: { command: 'old' }, kept: { command: 'k' } },
              },
            },
          ],
          ['b-over', { settings: { shell_environment_policy: { set: { LOG: '2' } } } }],
        ]),
      );
      const home = await harness.homeFor('f2' as FerretId);

      await harness.prepareHome({
        ...spec('f2', home),
        parts: [{ kind: 'mcp', name: 'docs', config: { command: 'docs-mcp' } }],
      } as never);

      const config = await readFile(join(home, 'config.toml'), 'utf8');
      expect(config).toContain('[shell_environment_policy.set]\nLOG = "2"\nKEEP = "yes"');
      expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"');
      expect(config).toContain('[mcp_servers.kept]\ncommand = "k"');
      expect(config).not.toContain('"old"');
    });

    test('m7 a composition without a configuration port says once that no settings item reaches a home', async () => {
      const warned: string[] = [];
      const { harness } = build(new Map(), { withoutConfig: true, warned });

      await harness.prepareHome(spec('f2', await harness.homeFor('f2' as FerretId)));
      await harness.prepareHome(spec('f2', await harness.homeFor('f2' as FerretId)));

      // (A composition with no pool also says, once, that the ferret goes on with its own history.)
      const said = warned.filter(message => !message.includes('its own history'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('no configuration port');
    });

    test('O11b no settings item and no server still writes the one top-level key that answers the update prompt', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);

      await harness.prepareHome(spec('f2', home));

      expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('check_for_update_on_startup = false\n');
    });

    test('O11b a settings item that sets check_for_update_on_startup keeps the person’s value, true included', async () => {
      for (const value of [true, false]) {
        const { harness } = build(new Map([['mine', { settings: { check_for_update_on_startup: value } }]]));
        const home = await harness.homeFor('f2' as FerretId);

        await harness.prepareHome(spec('f2', home));

        const config = await readFile(join(home, 'config.toml'), 'utf8');
        expect(config).toBe(`check_for_update_on_startup = ${String(value)}\n`);
      }
    });

    test('a settings item that unsets the update key leaves nothing to say: a config.toml an earlier launch left is removed', async () => {
      const home = join(AGENT_HOMES(), 'f2');
      const present = async () => (await lstat(join(home, 'config.toml')).catch(() => undefined)) !== undefined;
      // an earlier launch's file (a reused home) that this launch's settings no longer say anything for
      await writeFile(join(home, 'config.toml'), 'check_for_update_on_startup = false\n');
      const { harness } = build(new Map([['quiet', { settings: { check_for_update_on_startup: null } }]]));

      const plan = await harness.prepareHome(spec('f2', await harness.homeFor('f2' as FerretId)));

      expect(await present()).toBe(false);
      expect(plan.files.map(file => String(file).split('/').pop())).toEqual(['AGENTS.md']);
      // and with nothing left to clear, a second launch has nothing to remove and does not fail
      await harness.prepareHome(spec('f2', await harness.homeFor('f2' as FerretId)));
      expect(await present()).toBe(false);
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

  // ─── the login's sign-in file: Logins' shared credential linked into the Codex home (kernel `linkCredential`) ───────────

  describe('prepareHome links the login’s sign-in file into the Codex home', () => {
    const FAKE = '{"tokens":{"access_token":"fake-access","refresh_token":"fake-refresh"}}\n';
    /** The file Logins keeps, and the shared credential its real kernel roots mint for it (fake tokens only). */
    async function mintedCredential(): Promise<{ readonly credential: SharedCredential; readonly canonical: string }> {
      const canonical = join(fixture, 'fy-home/state/logins/credentials/work/auth.json');
      await mkdir(join(canonical, '..'), { recursive: true, mode: 0o700 });
      await writeFile(canonical, FAKE, { mode: 0o600 });
      const roots = rootsPortFor(
        nodeFs(() => crypto.randomUUID()),
        { home: join(fixture, 'fy-home'), plugin: 'logins', worktrees: join(fixture, 'worktrees') },
        ['credentials'],
        () => undefined,
        { shareCredentials: ['auth.json'], privateFiles: ['state/logins/credentials'], onStop: () => {} },
      );
      return {
        credential: await roots.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'codex' }),
        canonical,
      };
    }
    const kind = async (path: string) =>
      (await lstat(path).catch(() => undefined))?.isSymbolicLink()
        ? 'link'
        : (await lstat(path).catch(() => undefined)) === undefined
          ? 'absent'
          : 'other';

    test('with spec.credential, auth.json is a link to the login’s file and Codex can read it', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { credential, canonical } = await mintedCredential();

      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      expect(await kind(join(home, 'auth.json'))).toBe('link');
      expect(await realpath(join(home, 'auth.json'))).toBe(await realpath(canonical));
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(FAKE);
    });

    test('a second prepare replaces the link it made with the credential minted for it, and the canonical file is untouched', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { credential, canonical } = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      // Each launch mints its own (a credential is single-use in the kernel).
      const next = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), credential: next.credential } as LaunchSpec);

      expect(await kind(join(home, 'auth.json'))).toBe('link');
      expect(await readFile(canonical, 'utf8')).toBe(FAKE);
    });

    test('the credential of an earlier launch links nothing a second time', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { credential } = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      await expect(harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec)).rejects.toThrow();

      expect(await kind(join(home, 'auth.json'))).toBe('absent');
    });

    test('without a credential, a stale link is removed and the file it pointed at is left alone', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { credential, canonical } = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      await harness.prepareHome(spec('f2', home));

      expect(await kind(join(home, 'auth.json'))).toBe('absent');
      expect(await readFile(canonical, 'utf8')).toBe(FAKE);
    });

    test('without a credential, a stale auth.json FILE is removed and said so (Codex may have replaced the link)', async () => {
      const warned: string[] = [];
      const { harness } = build(new Map(), { warned });
      const home = await harness.homeFor('f2' as FerretId);
      await writeFile(join(home, 'auth.json'), 'a stale copy');

      await harness.prepareHome(spec('f2', home));

      expect(await kind(join(home, 'auth.json'))).toBe('absent');
      const said = warned.filter(message => !message.includes('its own history'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('auth.json was a file, not the login’s link');
      expect(said[0]).not.toContain('a stale copy');
    });

    test('a stale FILE is replaced by the link when a credential is given', async () => {
      const { harness } = build(new Map(), { warned: [] });
      const home = await harness.homeFor('f2' as FerretId);
      const { credential } = await mintedCredential();
      await writeFile(join(home, 'auth.json'), 'a stale copy');

      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      expect(await kind(join(home, 'auth.json'))).toBe('link');
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(FAKE);
    });

    // ─── the link ends with the ferret or the login (c58-69): the sign-in is in a home only while it is wanted ───────────

    /** A launch of `ferret` under `login`, its credential minted for it: the link is there when this returns. */
    async function linkedFor(harness: ReturnType<typeof build>['harness'], ferret: string, login: string) {
      const home = await harness.homeFor(ferret as FerretId);
      const { credential, canonical } = await mintedCredential();
      await harness.prepareHome({ ...spec(ferret, home), login, credential } as LaunchSpec);
      expect(await kind(join(home, 'auth.json'))).toBe('link');
      return { home, canonical };
    }

    test('a ferret that stopped has the sign-in taken out of its home, and the login’s own file stays', async () => {
      const { harness } = build();
      const { home, canonical } = await linkedFor(harness, 'f2', 'work');

      await harness.credentials.released('f2');

      expect(await kind(join(home, 'auth.json'))).toBe('absent');
      expect(await readFile(canonical, 'utf8')).toBe(FAKE);
    });

    test('a stop clears a link this daemon did not place (it was restarted since the launch)', async () => {
      const { harness } = build();
      const { home } = await linkedFor(harness, 'f2', 'work');
      const { harness: restarted } = build();

      await restarted.credentials.released('f2');

      expect(await kind(join(home, 'auth.json'))).toBe('absent');
    });

    test('a revoked login clears every home it was linked into, and no other login’s', async () => {
      const { harness } = build();
      const one = await linkedFor(harness, 'f2', 'work');
      const two = await linkedFor(harness, 'f3', 'work');
      const other = await linkedFor(harness, 'f4', 'spare');

      await harness.credentials.revoked('work');

      expect(await kind(join(one.home, 'auth.json'))).toBe('absent');
      expect(await kind(join(two.home, 'auth.json'))).toBe('absent');
      expect(await kind(join(other.home, 'auth.json'))).toBe('link');
      expect(await readFile(one.canonical, 'utf8')).toBe(FAKE);
    });

    test('a login that was revoked once clears nothing a second time, and a relaunch under it links again', async () => {
      const { harness } = build();
      const { home } = await linkedFor(harness, 'f2', 'work');
      await harness.credentials.revoked('work');
      const { credential } = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), login: 'work', credential } as LaunchSpec);

      await harness.credentials.revoked('nobody');
      expect(await kind(join(home, 'auth.json'))).toBe('link');

      await harness.credentials.revoked('work');
      expect(await kind(join(home, 'auth.json'))).toBe('absent');
    });

    test('a ferret relaunched without a credential is no longer cleared by its old login', async () => {
      const { harness } = build();
      const { home } = await linkedFor(harness, 'f2', 'work');
      await harness.prepareHome(spec('f2', home));
      await writeFile(join(home, 'auth.json'), 'written by something else');

      await harness.credentials.revoked('work');

      expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('written by something else');
    });

    test('a login-less launch is never cleared by a revoked login', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { credential } = await mintedCredential();
      await harness.prepareHome({ ...spec('f2', home), credential } as LaunchSpec);

      await harness.credentials.revoked('work');

      expect(await kind(join(home, 'auth.json'))).toBe('link');
    });

    test('a file Codex wrote in the link’s place is a copy of the sign-in and goes too; a folder stays', async () => {
      const { harness } = build();
      const { home } = await linkedFor(harness, 'f2', 'work');
      await rm(join(home, 'auth.json'));
      await writeFile(join(home, 'auth.json'), FAKE);

      await harness.credentials.released('f2');
      expect(await kind(join(home, 'auth.json'))).toBe('absent');

      await mkdir(join(home, 'auth.json'));
      await writeFile(join(home, 'auth.json', 'keep'), 'x');
      await harness.credentials.released('f2');
      expect(await readFile(join(home, 'auth.json', 'keep'), 'utf8')).toBe('x');
    });

    test('a ferret with no home, or no sign-in in it, is cleared without a word', async () => {
      const warned: string[] = [];
      const { harness } = build(new Map(), { warned });
      await harness.homeFor('f2' as FerretId);

      await harness.credentials.released('never-started');
      await harness.credentials.released('f2');

      expect(warned).toEqual([]);
    });

    test('a removal that fails says so once by ferret id and never throws, and the next launch still clears the link', async () => {
      const warned: string[] = [];
      const { harness } = build(new Map(), { warned });
      const { home } = await linkedFor(harness, 'f2', 'work');
      await chmod(home, 0o500);
      try {
        await harness.credentials.released('f2');
      } finally {
        await chmod(home, 0o700);
      }

      expect(warned.filter(message => message.includes('f2'))).toHaveLength(1);
      expect(warned.join(' ')).not.toContain(home);
      expect(await kind(join(home, 'auth.json'))).toBe('link');
      await harness.prepareHome(spec('f2', home));
      expect(await kind(join(home, 'auth.json'))).toBe('absent');
    });

    test('an id that is not one plain name is refused without touching anything', async () => {
      const warned: string[] = [];
      const { harness } = build(new Map(), { warned });
      const { home } = await linkedFor(harness, 'f2', 'work');

      await harness.credentials.released('../f2');

      expect(await kind(join(home, 'auth.json'))).toBe('link');
      expect(warned.filter(message => message.includes('../f2'))).toHaveLength(1);
    });

    test('a folder at auth.json is refused, never removed', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      await mkdir(join(home, 'auth.json'));
      await writeFile(join(home, 'auth.json', 'keep'), 'x');

      await expect(harness.prepareHome(spec('f2', home))).rejects.toThrow('auth.json');
      expect(await readFile(join(home, 'auth.json', 'keep'), 'utf8')).toBe('x');
    });

    test('a credential minted for another plugin is refused and no link is made', async () => {
      const { harness } = build();
      const home = await harness.homeFor('f2' as FerretId);
      const { canonical } = await mintedCredential();
      const roots = rootsPortFor(
        nodeFs(() => crypto.randomUUID()),
        { home: join(fixture, 'fy-home'), plugin: 'logins', worktrees: join(fixture, 'worktrees') },
        ['credentials'],
        () => undefined,
        { shareCredentials: ['auth.json'], privateFiles: ['state/logins/credentials'], onStop: () => {} },
      );
      const other = await roots.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'claude-code' });

      await expect(harness.prepareHome({ ...spec('f2', home), credential: other } as LaunchSpec)).rejects.toThrow();
      expect(await kind(join(home, 'auth.json'))).toBe('absent');
      expect(await readFile(canonical, 'utf8')).toBe(FAKE);
    });
  });

  // ─── skills: Skills' shared folders linked into the Codex home (kernel batch #10, owner decision ^A466) ──────────────

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
      await harness.prepareHome({
        ...spec('f2', home),
        parts: [{ kind: 'skill', name: 'review', tree }],
      } as LaunchSpec);
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
      await harness.prepareHome({
        ...spec('f2', home),
        parts: [{ kind: 'skill', name: '.system', tree }],
      } as LaunchSpec);
      expect(await readFile(join(home, 'skills', '.system', 'bundled.md'), 'utf8')).toBe('codex\n');
    });
  });
}
