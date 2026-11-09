import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LaunchSpec, Runner } from '@ferretry/core-ferrets/contract';
import { FakeRunner, harnessConformance } from '@ferretry/core-ferrets/contract/testing';
import type { FerretId, SpawnResult, StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { state as kernelState } from '@ferretry/kernel/host';
import { CLAUDE_CODE_HOOKS, CLAUDE_CODE_LAUNCH_SETTINGS, CLAUDE_CODE_SETTINGS } from '../../contract/index.ts';
import { type Instant, ok } from '@ferretry/std';
import { ClaudeHarness } from '../../daemon/adapters/claude-harness.ts';
import { API_KEY_SEED_NAME, API_KEY_SEED_SCRIPT, API_KEY_SEED_SHELL } from '../../daemon/lib/harness/api-key-seed.ts';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';
import { ClaudeProjectApprovals } from '../../daemon/lib/project-approvals.ts';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInternalRootBases, rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';

const FERRET = 'f1' as FerretId;
let fixture: string;
let HOME: string;
let HISTORY: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'claude-harness-unit-'));
  HOME = join(fixture, 'fy-home/state/claude-code/agent-homes/f1');
  HISTORY = join(fixture, 'owner/.claude');
  await mkdir(HOME, { recursive: true });
  await mkdir(join(fixture, 'fy-home/state/claude-code/agent-homes/f2'), { recursive: true });
  await mkdir(HISTORY, { recursive: true });
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});
const T = '2026-11-01T10:00:00.000Z' as Instant;

function build(
  options: {
    located?: boolean;
    tmux?: (args: readonly string[]) => number;
    state?: StatePort;
    config?: { file: () => unknown; collection: (definition: unknown) => unknown };
  } = {},
) {
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    {
      home: join(fixture, 'fy-home'),
      plugin: 'claude-code',
      worktrees: join(fixture, 'worktrees'),
    },
    ['agent-homes', 'harness-history'],
    () => undefined,
  );
  const writeHome = async (relative: string, text: string) => {
    const home = roots.root('agent-homes', { subfolder: FERRET });
    const path = home.resolve(relative);
    if (!path.ok) throw new Error('invalid test fixture path');
    await home.writeText(path.value, text);
  };
  const tmux: string[][] = [];
  const panes = new PaneDirectory();
  const harness = new ClaudeHarness({
    roots,
    config: (options.config ?? {
      file: () => ({ searchPaths: [], permissionMode: 'auto' }),
      collection: () => new Map(),
    }) as never,
    state: options.state ?? new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]),
    spawn: {
      run: async (_program: string, args: readonly string[]): Promise<SpawnResult> => {
        tmux.push([...args]);
        return { exitCode: options.tmux?.(args) ?? 0, signal: null, stdout: '', stderr: '' } as SpawnResult;
      },
    } as never,
    clock: { sleep: async () => {} } as never,
    redaction: {
      read: async (fn: (scope: unknown) => unknown) =>
        await fn({
          text: (s: string) => s.replaceAll('SECRET', '******'),
          lines: (l: unknown) => l,
          cells: (g: unknown) => g,
        }),
    } as never,
    location: {
      locate: async () =>
        options.located === false
          ? { outcome: 'absent', searched: ['PATH'] }
          : { outcome: 'located', path: '/opt/bin/claude', rule: 'x', declaredBy: 'PATH' },
    } as never,
    probe: { version: async () => ({ state: 'ok', version: '2.1.220' }) } as never,
    update: {} as never,
    panes,
    permission: {} as never,
    dialog: {} as never,
    newConversationId: () => 'conv-1',
    historyHome: async () => HISTORY,
  });
  return { harness, roots, writeHome, tmux, panes };
}

const spec = (more: Record<string, unknown> = {}): LaunchSpec =>
  ({
    ferret: FERRET,
    name: 'a',
    role: 'lead',
    harness: 'claude-code',
    folder: '/work',
    home: HOME,
    instructions: [{ plugin: 'x', id: 'i', text: 'Be brief.', when: {} }],
    parts: [{ kind: 'mcp', name: 'docs', config: { command: 'docs-mcp' } }],
    ...more,
  }) as unknown as LaunchSpec;

const runner = (started: { command?: readonly string[]; cwd?: string }): Runner =>
  ({
    key: 'tmux',
    start: async (run: { command: readonly string[]; cwd: string }) => {
      started.command = run.command;
      started.cwd = run.cwd;
      return ok({ handle: '%7', startedAt: T });
    },
    stop: async () => {},
  }) as unknown as Runner;

describe('ClaudeHarness', () => {
  test('S40 prepares isolated per-ferret homes using the real kernel roots and validates spec.home', async () => {
    const { harness } = build();
    await harness.prepareHome(spec());
    const secondHome = join(fixture, 'fy-home/state/claude-code/agent-homes/f2');
    await harness.prepareHome(spec({ ferret: 'f2', home: secondHome, instructions: [], parts: [] }));
    expect(await readFile(join(HOME, 'CLAUDE.md'), 'utf8')).toBe('Be brief.\n');
    expect(await readFile(join(secondHome, 'CLAUDE.md'), 'utf8')).toBe('');
    await expect(harness.prepareHome(spec({ home: secondHome }))).rejects.toThrow('does not match');
    await expect(harness.prepareHome(spec({ ferret: '../f2' }))).rejects.toThrow('plain name');
  });

  test('S41 real roots refuse a home settings symlink that escapes its ferret subfolder', async () => {
    const { harness } = build();
    await Bun.write(join(fixture, 'outside.json'), '{}');
    await symlink(join(fixture, 'outside.json'), join(HOME, 'settings.json'));
    await expect(harness.prepareHome(spec())).rejects.toThrow('link_escape');
  });

  const AGENT_HOMES = () => join(fixture, 'fy-home/state/claude-code/agent-homes');
  const listing = async (folder: string) => (await readdir(folder)).sort();

  for (const target of ['sibling', 'outside'] as const) {
    test(`S42 a ferret home linked to a ${target} folder is refused before any write`, async () => {
      const { harness } = build();
      const destination = target === 'sibling' ? join(AGENT_HOMES(), 'f2') : join(fixture, 'outside');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'CLAUDE.md'), 'other-home-fixture');
      const linked = join(AGENT_HOMES(), 'f3');
      await symlink(destination, linked);
      const f3 = spec({ ferret: 'f3', home: linked });
      await expect(harness.prepareHome(f3)).rejects.toThrow('root refused');
      await expect(harness.start(f3, runner({}), {} as never)).rejects.toThrow('root refused');
      expect(await listing(destination)).toEqual(['CLAUDE.md']);
      expect(await readFile(join(destination, 'CLAUDE.md'), 'utf8')).toBe('other-home-fixture');
      expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    });
  }

  test('S42 a linked agent-homes parent is refused before any write', async () => {
    const { harness } = build();
    const outside = join(fixture, 'outside');
    await mkdir(outside);
    await rm(AGENT_HOMES(), { recursive: true });
    await symlink(outside, AGENT_HOMES());
    await expect(harness.prepareHome(spec({ ferret: 'f9', home: join(AGENT_HOMES(), 'f9') }))).rejects.toThrow(
      'link_escape',
    );
    expect(await readdir(outside)).toEqual([]);
  });

  test('S42 a home swapped for a sibling link after launch is refused at read time', async () => {
    const { harness, writeHome } = build();
    const record = JSON.stringify({ type: 'assistant', uuid: 'theirs', timestamp: T, message: { content: [] } });
    await harness.start(spec(), runner({}), {} as never);
    // f2 holds a conversation association and transcript of its own, under f1's assigned id.
    const f2 = join(AGENT_HOMES(), 'f2');
    await writeFile(join(f2, 'conversation.json'), JSON.stringify({ format: 1, id: 'conv-1', cwd: '/work' }));
    await mkdir(join(f2, 'projects/-work'), { recursive: true });
    await writeFile(join(f2, 'projects/-work/conv-1.jsonl'), record);
    await writeHome('projects/-work/conv-1.jsonl', record.replace('theirs', 'ours'));
    expect((await harness.transcript.read(FERRET)).map(entry => entry.id)).toEqual(['ours']);
    await rm(HOME, { recursive: true });
    await symlink(f2, HOME);
    expect(await harness.transcript.read(FERRET)).toEqual([]);
    expect(await harness.usage.turns(FERRET)).toEqual([]);
    await expect(harness.prepareHome(spec())).rejects.toThrow('root refused');
    expect(await listing(f2)).toEqual(['conversation.json', 'projects']);
  });

  test('S42 a fresh ferret with only the agent-homes parent gets a private home made by the kernel and launches', async () => {
    const { harness } = build();
    const fresh = join(AGENT_HOMES(), 'fresh');
    const started: { command?: readonly string[] } = {};
    const result = await harness.start(spec({ ferret: 'fresh', home: fresh }), runner(started), {} as never);
    expect(result.ok).toBe(true);
    expect((await lstat(fresh)).isDirectory()).toBe(true);
    expect((await lstat(fresh)).mode & 0o777).toBe(0o700);
    expect(await listing(fresh)).toEqual(
      ['.claude.json', 'CLAUDE.md', 'conversation.json', 'launch-settings.json', 'mcp.json', 'settings.json'].sort(),
    );
    expect(started.command).toContain(`CLAUDE_CONFIG_DIR=${fresh}`);
  });

  test('S42 first launch on a fresh FY_HOME: the kernel made the agent-homes base 0700 at boot, the launch makes the ferret home under it', async () => {
    // A brand-new home: no state folder at all, none of the fixture's planted homes.
    const fy = join(fixture, 'fy-home');
    await rm(fy, { recursive: true });
    await mkdir(fy, { mode: 0o700 });
    expect(
      await ensureInternalRootBases(
        nodeFs(() => 'fixture'),
        { home: fy, plugin: 'claude-code' },
        ['agent-homes', 'harness-history'],
      ),
    ).toEqual([]);
    expect((await lstat(AGENT_HOMES())).mode & 0o777).toBe(0o700);
    expect(await readdir(AGENT_HOMES())).toEqual([]);
    const { harness } = build();
    const started: { command?: readonly string[] } = {};
    expect((await harness.start(spec(), runner(started), {} as never)).ok).toBe(true);
    expect((await lstat(HOME)).mode & 0o777).toBe(0o700);
    expect(await readdir(AGENT_HOMES())).toEqual(['f1']);
    expect(started.command).toContain(`CLAUDE_CONFIG_DIR=${HOME}`);
  });

  test('S42 first launch on a fresh FY_HOME whose kernel did not run: the harness refuses and makes no base of its own', async () => {
    const fy = join(fixture, 'fy-home');
    await rm(fy, { recursive: true });
    await mkdir(fy, { mode: 0o700 });
    const { harness } = build();
    const started: { command?: readonly string[] } = {};
    await expect(harness.start(spec(), runner(started), {} as never)).rejects.toThrow('root refused');
    expect(started.command).toBeUndefined();
    expect(await readdir(fy)).toEqual([]);
  });

  test('S42 homeFor names state/claude-code/agent-homes/<ferret> through its own root, and that home launches', async () => {
    const { harness } = build();
    const fy = join(fixture, 'fy-home');
    expect(await harness.homeFor('f1' as FerretId)).toBe(HOME as never);
    expect(await harness.homeFor('fresh' as FerretId)).toBe(join(AGENT_HOMES(), 'fresh') as never);
    expect(await harness.homeFor('f2' as FerretId)).not.toBe(await harness.homeFor('f1' as FerretId));
    await expect(harness.homeFor('../f2' as FerretId)).rejects.toThrow('plain name');
    // The home Ferrets used to hand every harness (its own shared agent-homes) is refused before any write.
    const shared = join(fy, 'state/ferrets/agent-homes');
    await expect(harness.prepareHome(spec({ ferret: 'fresh', home: shared }))).rejects.toThrow('does not match');
    // A fresh ferret beside f1 and f2 on the existing agent-homes base launches in exactly homeFor's answer.
    const home = await harness.homeFor('fresh' as FerretId);
    await harness.prepareHome(spec({ ferret: 'fresh', home }));
    const started: { command?: readonly string[] } = {};
    expect((await harness.start(spec({ ferret: 'fresh', home }), runner(started), {} as never)).ok).toBe(true);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    expect(started.command).toContain(`CLAUDE_CONFIG_DIR=${home}`);
  });

  test('S42 an existing home is narrowed to 0700, and a home that is a file is refused', async () => {
    const { harness } = build();
    await chmod(HOME, 0o755);
    await harness.prepareHome(spec());
    expect((await lstat(HOME)).mode & 0o777).toBe(0o700);
    const asFile = join(AGENT_HOMES(), 'f4');
    await writeFile(asFile, 'not-a-folder');
    await expect(harness.prepareHome(spec({ ferret: 'f4', home: asFile }))).rejects.toThrow('root refused');
    expect(await readFile(asFile, 'utf8')).toBe('not-a-folder');
  });

  test('discovers conversations from an absolute read-only history scope with real roots', async () => {
    const { harness, roots } = build();
    await mkdir(join(HISTORY, 'projects/p'), { recursive: true });
    await Bun.write(join(HISTORY, 'projects/p/c-1.jsonl'), `${JSON.stringify({ cwd: '/work' })}\n`);
    await Bun.write(join(HISTORY, 'projects/p/c-2.jsonl'), `${JSON.stringify({ cwd: '/elsewhere' })}\n`);
    expect((await harness.conversations.list(spec().folder)).map(item => [item.id, item.folder])).toEqual([
      ['c-1', '/work'],
    ]);
    const history = roots.root('harness-history', { subfolder: HISTORY });
    const file = history.resolve('projects/p/c-1.jsonl');
    if (!file.ok) throw new Error('invalid fixture');
    await expect(history.writeText(file.value, 'changed')).rejects.toThrow('read_only');
    expect(roots.root('harness-history').resolve('projects').ok).toBe(false);
  });

  test('S41 conversation discovery refuses a history symlink that leaves its root', async () => {
    const { harness } = build();
    await mkdir(join(fixture, 'outside'), { recursive: true });
    await Bun.write(join(fixture, 'outside/other.jsonl'), JSON.stringify({ cwd: '/work' }));
    await mkdir(join(HISTORY, 'projects'), { recursive: true });
    await symlink(join(fixture, 'outside'), join(HISTORY, 'projects/escape'));
    expect(await harness.conversations.list()).toEqual([]);
  });

  test('binds transcript and usage to the resumed id and encoded cwd, even after a daemon restart', async () => {
    const { harness, writeHome } = build();
    const record = (id: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid: id,
        timestamp: T,
        message: { content: [{ type: 'text', text: id }], usage: { input_tokens: 7, output_tokens: 2 } },
      });
    await writeHome('projects/-work-repo-a/older.jsonl', record('ours'));
    await utimes(join(HOME, 'projects/-work-repo-a/older.jsonl'), 1, 1);
    await writeHome('projects/-work-repo-a/newer.jsonl', record('other-id'));
    await writeHome('projects/wrong-cwd/older.jsonl', record('wrong-cwd'));
    await harness.resume(spec({ folder: '/work/repo.a' }), runner({}), {} as never, 'older');
    expect((await harness.transcript.read(FERRET)).map(entry => entry.id)).toEqual(['ours']);
    const restarted = build().harness;
    expect((await restarted.transcript.read(FERRET)).map(entry => entry.id)).toEqual(['ours']);
    expect((await restarted.usage.turns(FERRET)).map(turn => turn.inputTokens)).toEqual([7]);
    await restarted.start(spec({ folder: '/work/repo.a' }), runner({}), {} as never);
    expect(await restarted.transcript.read(FERRET)).toEqual([]);
    expect(await restarted.usage.turns(FERRET)).toEqual([]);
  });

  test('S45 refuses invalid conversation ids at resume and when recovering a persisted association', async () => {
    const { harness, writeHome } = build();
    for (const id of ['../other', '/other', '_first', 'a'.repeat(129), '']) {
      await expect(harness.resume(spec(), runner({}), {} as never, id)).rejects.toThrow('S45');
      await writeHome('conversation.json', JSON.stringify({ format: 1, id, cwd: '/work' }));
      expect(await harness.transcript.read(FERRET)).toEqual([]);
    }
    await writeHome('conversation.json', '{broken');
    expect(await harness.transcript.read(FERRET)).toEqual([]);
  });

  test('discover finds claude and its version without reading any sign-in file', async () => {
    expect(await build().harness.discover()).toEqual({ found: true, binary: '/opt/bin/claude', version: '2.1.220' });
    expect((await build({ located: false }).harness.discover()).found).toBe(false);
  });

  test('prepareHome writes instructions, settings and MCP inside the ferret home and nowhere else', async () => {
    const { harness } = build();

    const plan = await harness.prepareHome(spec({ effort: 'high' }));

    expect(plan.files.every(path => path.startsWith(`${HOME}/`))).toBe(true);
    expect(plan.files.length).toBe(5);
    expect(await readFile(join(HOME, 'CLAUDE.md'), 'utf8')).toContain('Be brief.');
  });

  test('a settings item reaches the Claude home: its env rides settings.json and a secret stays the reference it is written as', async () => {
    const { harness } = build({
      config: {
        file: () => ({ searchPaths: [], permissionMode: 'auto' }),
        collection: definition =>
          definition === CLAUDE_CODE_SETTINGS
            ? new Map([['guard', { settings: { env: { LOG: '1', GUARD: '${secret:GUARD_VALUE}' } } }]])
            : new Map(),
      },
    });

    await harness.prepareHome(spec());

    const settings = JSON.parse(await readFile(join(HOME, 'settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };
    expect(settings.env).toEqual({ LOG: '1', GUARD: '${secret:GUARD_VALUE}' });
  });

  describe(".claude.json is merged at every launch, never replaced (today's wrapper seed)", () => {
    const claudeJson = () => join(HOME, '.claude.json');
    type Document = Record<string, unknown> & { projects: Record<string, Record<string, unknown>> };
    const document = async () => JSON.parse(await readFile(claudeJson(), 'utf8')) as Document;
    const project = (doc: Document, root: string): Record<string, unknown> => doc.projects[root] ?? {};
    const approvals = (roots: ReturnType<typeof build>['roots']) =>
      new ClaudeProjectApprovals(
        ferret => roots.root('agent-homes', { ferret, subfolder: ferret }),
        () => roots.root('agent-homes'),
      );

    test('a project server disabled in Claude stays disabled across three launches', async () => {
      const { harness, roots } = build();
      const ask = async () =>
        await approvals(roots).approvedProjectServers({ ferret: FERRET, root: '/work', servers: ['docs', 'tracker'] });

      await harness.prepareHome(spec());
      // Session 1: the person approves one server and disables the other inside Claude, which writes them here.
      const first = await document();
      project(first, '/work').enabledMcpjsonServers = ['docs'];
      project(first, '/work').disabledMcpjsonServers = ['tracker'];
      await writeFile(claudeJson(), JSON.stringify(first));

      for (const launch of [2, 3, 4]) {
        await harness.prepareHome(spec());
        const now = await document();
        expect([launch, project(now, '/work').disabledMcpjsonServers]).toEqual([launch, ['tracker']]);
        expect(await ask()).toEqual({ state: 'read', servers: { docs: 'approved', tracker: 'disabled' } });
      }
    });

    test('the trust key and the fixed keys are set, and every other key is kept', async () => {
      const { harness } = build();
      await writeFile(
        claudeJson(),
        JSON.stringify({
          userID: 'fake-user-id',
          hasCompletedOnboarding: false,
          projects: { '/work': { allowedTools: ['Bash'] }, '/elsewhere': { enabledMcpjsonServers: ['x'] } },
        }),
      );

      const plan = await harness.prepareHome(spec());

      const now = await document();
      expect(now.userID).toBe('fake-user-id');
      expect(now.hasCompletedOnboarding).toBe(true);
      expect(now.projects['/work']).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
      expect(now.projects['/elsewhere']).toEqual({ enabledMcpjsonServers: ['x'] });
      expect(plan.files as readonly string[]).toContain(claudeJson());
    });

    test('an already-seeded document is not rewritten', async () => {
      const { harness } = build();
      await harness.prepareHome(spec());
      const plan = await harness.prepareHome(spec());
      expect(plan.files as readonly string[]).not.toContain(claudeJson());
      expect(plan.files.length).toBe(4);
    });

    test('a .claude.json that is not JSON is left as it is, and the approvals read then answers unreadable', async () => {
      const { harness, roots } = build();
      await writeFile(claudeJson(), '{"projects": {"/work": {"disabledMcpjsonServers": ["tracker"]');

      const plan = await harness.prepareHome(spec());

      expect(await readFile(claudeJson(), 'utf8')).toBe(
        '{"projects": {"/work": {"disabledMcpjsonServers": ["tracker"]',
      );
      expect(plan.files as readonly string[]).not.toContain(claudeJson());
      const answer = await approvals(roots).approvedProjectServers({
        ferret: FERRET,
        root: '/work',
        servers: ['tracker'],
      });
      expect(answer.state).toBe('unreadable');
    });

    test('a .claude.json linked out of the home is refused before it is read or written', async () => {
      const { harness } = build();
      await writeFile(join(fixture, 'outside.json'), '{"outside":true}');
      await symlink(join(fixture, 'outside.json'), claudeJson());
      await expect(harness.prepareHome(spec())).rejects.toThrow();
      expect(await readFile(join(fixture, 'outside.json'), 'utf8')).toBe('{"outside":true}');
    });
  });

  test('start runs claude in the home with a session id the daemon assigned, and remembers the pane', async () => {
    const { harness, panes } = build();
    const started: { command?: readonly string[]; cwd?: string } = {};

    const result = await harness.start(spec({ model: 'claude-opus-5-5' }), runner(started), {} as never);

    expect(result.ok && result.value.harnessConversation).toBe('conv-1');
    expect(started.cwd).toBe('/work');
    expect(started.command?.slice(0, 7)).toEqual([
      'env',
      `CLAUDE_CONFIG_DIR=${HOME}`,
      API_KEY_SEED_SHELL,
      '-c',
      API_KEY_SEED_SCRIPT,
      API_KEY_SEED_NAME,
      '/opt/bin/claude',
    ]);
    expect(started.command).toContain('--session-id');
    expect(started.command?.slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
    expect(panes.require(FERRET)).toBe('%7');
  });

  test('a start and a resume turn the spec’s readable folders into one read-only allowance each, and nothing more', async () => {
    // Arrange: the folders Ferrets hands for this ferret's own session (LaunchSpec.readable).
    const { harness } = build();
    const own = '/fy/state/ferrets/sessions/f1';
    const readable = [`${own}/turns`, `${own}/channel`, `${own}/attachments`];
    const started: { command?: readonly string[] } = {};
    const resumed: { command?: readonly string[] } = {};

    // Act
    await harness.start(spec({ readable }), runner(started), {} as never);
    // A resume launches through the runner's start too, with `--resume`.
    await harness.resume(spec({ readable }), runner(resumed), {} as never, 'conv-1');

    // Assert: today's spelling, one per folder, on both; never the session folder itself (environment.json).
    const expected = readable.map(folder => `--allowedTools=Read(/${folder}/**)`);
    for (const command of [started.command, resumed.command])
      expect(command?.filter(argument => argument.includes('allowedTools'))).toEqual(expected);
    expect(resumed.command).toContain('--resume');
    expect(started.command?.some(argument => argument === `--allowedTools=Read(/${own}/**)`)).toBe(false);
  });

  test('the runner is handed an argv that never carries the API key or its tail', async () => {
    const { harness } = build();
    const fakeKey = `sk-ant-fake-${'0'.repeat(28)}`;
    // The environment is opaque to the harness (Vault opens it in the child); a value placed in it must not surface.
    const env = { names: ['ANTHROPIC_API_KEY'], ANTHROPIC_API_KEY: fakeKey } as never;
    for (const run of [
      async (r: Runner) => await harness.start(spec(), r, env),
      async (r: Runner) => await harness.resume(spec(), r, env, 'older-conversation'),
    ]) {
      const started: { command?: readonly string[] } = {};
      await run(runner(started));
      const argv = started.command ?? [];
      expect(argv.length > 0).toBe(true);
      expect(argv.some(word => word.includes(fakeKey.slice(-20)))).toBe(false);
      expect(argv.some(word => word.includes('ANTHROPIC_API_KEY='))).toBe(false);
    }
  });

  test('resume names the harness conversation, not a new one', async () => {
    const { harness } = build();
    const started: { command?: readonly string[] } = {};

    await harness.resume(spec(), runner(started), {} as never, 'older-conversation');

    expect(started.command).toContain('--resume');
    expect(started.command).toContain('older-conversation');
    expect(started.command).not.toContain('--session-id');
  });

  test('start says unavailable, and starts nothing, when claude is not there', async () => {
    const started: { command?: readonly string[] } = {};

    const result = await build({ located: false }).harness.start(spec(), runner(started), {} as never);

    expect(result.ok).toBe(false);
    expect(started.command).toBeUndefined();
  });

  test('deliver types the message into the pane once per message id', async () => {
    const { harness, tmux } = build();

    const first = await harness.deliver(FERRET, '%7' as never, { id: 'm1', text: 'hello' } as never);
    const again = await harness.deliver(FERRET, '%7' as never, { id: 'm1', text: 'hello' } as never);

    expect(first).toEqual({ status: 'delivered', id: 'm1' });
    expect(again).toEqual({ status: 'delivered', id: 'm1' });
    expect(tmux).toEqual([
      ['send-keys', '-t', '%7', '-l', '--', 'hello'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  test('deliver is refused, with tmux words, when the pane cannot be typed into', async () => {
    const { harness } = build({ tmux: () => 1 });

    const result = await harness.deliver(FERRET, '%7' as never, { id: 'm2', text: 'x' } as never);

    expect(result.status).toBe('refused');
  });

  test('a ferret with no conversation has an empty transcript, not an error', async () => {
    expect(await build().harness.transcript.read(FERRET)).toEqual([]);
  });

  test('the transcript is read from its assigned conversation in the home, masked as it leaves', async () => {
    const { harness, writeHome } = build();
    await harness.start(spec(), runner({}), {} as never);
    await writeHome(
      'projects/-work/conv-1.jsonl',
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: T, message: { content: 'my SECRET here' } })}\n${JSON.stringify(
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: T,
          message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } },
        },
      )}`,
    );

    const entries = await harness.transcript.read(FERRET);

    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect(entries.length).toBe(2);
  });

  test('U5 the transcript stamp and tail name only the assigned conversation, and carry no text', async () => {
    const { harness, writeHome } = build();
    expect(await harness.transcriptStamp(FERRET)).toBeUndefined();
    expect(await harness.transcriptTail(FERRET, 10)).toEqual({ kind: 'unresolved' });

    await harness.start(spec(), runner({}), {} as never);
    await writeHome(
      'projects/-work/conv-1.jsonl',
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: T, message: { content: 'my SECRET here' } })}\n${JSON.stringify(
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: T,
          message: {
            id: 'm1',
            content: [{ type: 'text', text: 'SECRET reply' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        },
      )}\n`,
    );

    const stamp = await harness.transcriptStamp(FERRET);
    expect(stamp?.file).toEndWith('conv-1.jsonl');
    expect(stamp?.size).toBeGreaterThan(0);
    const tail = await harness.transcriptTail(FERRET, 10);
    if (tail.kind !== 'read') throw new Error('the tail reads');
    expect(tail.records.map(record => record.kind)).toEqual(['message', 'message', 'usage', 'turn']);
    expect(JSON.stringify(tail)).not.toContain('SECRET');
  });

  test('U5 a newest record larger than the tail window reads as a turn at work, with no wider read', async () => {
    const { harness, writeHome } = build();
    await harness.start(spec(), runner({}), {} as never);
    const done = JSON.stringify({
      type: 'assistant',
      uuid: 'a0',
      timestamp: T,
      message: { id: 'm0', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    });
    const bigResult = (bytes: number) =>
      JSON.stringify({
        type: 'user',
        uuid: 'u9',
        timestamp: T,
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(bytes) }] },
      });

    // 600 KB: past the 512 KB window. The window is never widened (one wider parse is a >5 ms slice on the main thread),
    // so the older end-of-turn record behind it is NOT seen: the turn is at work, never "no transcript".
    await writeHome('projects/-work/conv-1.jsonl', `${done}\n${bigResult(600 * 1024)}\n`);
    const cut = await harness.transcriptTail(FERRET, 10);
    expect(cut).toEqual({ kind: 'read', records: [{ kind: 'work' }] });

    // 5 MB: the same answer.
    await writeHome('projects/-work/conv-1.jsonl', `${done}\n${bigResult(5 * 1024 * 1024)}\n`);
    expect(await harness.transcriptTail(FERRET, 10)).toEqual({ kind: 'read', records: [{ kind: 'work' }] });
  });

  test('dialogs.current finds nothing on an empty pane and answer refuses a prompt that is gone', async () => {
    const { harness, panes } = build();
    panes.remember(FERRET, '%7');

    expect(await harness.dialogs.current(FERRET)).toBeUndefined();
    expect(await harness.dialogs.answer(FERRET, '0123456789abcdef', '1')).toMatchObject({ status: 'refused' });
  });
});

harnessConformance('Claude Code (real kernel roots)', () => {
  const { harness, tmux } = build();
  return {
    harness,
    runner: new FakeRunner(),
    spec: spec(),
    // Each delivery that reaches the ferret types its text into the pane once (`send-keys -l`).
    deliveredCount: () => tmux.filter(args => args[0] === 'send-keys' && args.includes('-l')).length,
  };
});

// ─── W2-c: what a launch ran under (Harness.launchSettings; today's FileLaunchSettingsDigest, F-0422) ──────────────

/**
 * The REAL kernel state port (the subsystem damage policy is the kernel's, not `MemoryStateFolder`'s) over an
 * in-memory disk, holding one healthy record (`f2`) and one record of the named kind of bad (`f1`).
 */
const damagedShapes = {
  'wrong schema': '{"format":1,"sections":{}}\n',
  'not JSON': 'not json at all',
  'a link (the disk refuses to read it)': undefined,
} as const;

async function realPortWithBadRecord(shape: keyof typeof damagedShapes, healthy: string) {
  const memory = kernelState.createMemoryHostFs();
  const base = '/fy/state/claude-code/launch-settings';
  const link = `${base}/f1.json`;
  await memory.writeAtomic(`${base}/f2.json`, healthy, 0o600);
  await memory.writeAtomic(link, damagedShapes[shape] ?? '{}', 0o600);
  const fs = {
    ...memory,
    readText: async (path: string) => {
      if (shape.startsWith('a link') && path === link) throw new Error('ELOOP: a link is never followed');
      return await memory.readText(path);
    },
    readBytes: async (path: string) => {
      if (shape.startsWith('a link') && path === link) throw new Error('ELOOP: a link is never followed');
      return await memory.readBytes(path);
    },
  };
  const opening = await kernelState.openPluginState({
    home: '/fy',
    pluginId: 'claude-code',
    files: [CLAUDE_CODE_LAUNCH_SETTINGS],
    fs,
    clock: { now: () => 0 as never },
    kind: 'plugin',
    liveTargets: true,
  });
  const changed: unknown[] = [];
  const port = kernelState.createStatePort({
    home: '/fy',
    pluginId: 'claude-code',
    files: [CLAUDE_CODE_LAUNCH_SETTINGS],
    fs,
    initialDamage: opening.damaged,
    initialNarrowed: opening.narrowed,
    changed: damage => changed.push(damage),
  });
  return { opening, port, changed, memory };
}

const HEALTHY_RECORD = `${JSON.stringify({ format: 1, sections: Object.fromEntries(['fixed-layer', 'hooks', 'permission-mode', 'settings'].map(name => [name, 'a'.repeat(64)])) })}\n`;

describe('F-0422 one bad launch-settings record is that ferret’s nothing-to-say, never the whole plugin’s damage', () => {
  for (const shape of Object.keys(damagedShapes) as (keyof typeof damagedShapes)[]) {
    test(`F-0422 ${shape}: the plugin stays healthy at boot and on a read, the answer is unknown, and another ferret is unaffected`, async () => {
      const { opening, port, changed } = await realPortWithBadRecord(shape, HEALTHY_RECORD);
      expect(CLAUDE_CODE_LAUNCH_SETTINGS.onDamaged).not.toBe('subsystem');
      // Boot: nothing the plugin answers `store_damaged` over.
      expect(opening.damaged).toEqual([]);

      const { harness } = build({ state: port });
      const bad = await harness.launchSettings(FERRET);
      const good = await harness.launchSettings('f2' as FerretId);

      expect(bad).toEqual({ kind: 'unknown' });
      // Runtime: the read did not flip the subsystem, and the host was never told of damage.
      expect(port.damaged()).toEqual([]);
      expect(changed).toEqual([]);
      // The neighbour's record still reads (it names settings this config does not have, so it is not unknown).
      expect(good.kind).not.toBe('unknown');
    });

    test(`F-0422 ${shape}: the ferret's next launch still starts and clears the bad record, with the plugin healthy throughout`, async () => {
      const { port, changed, memory } = await realPortWithBadRecord(shape, HEALTHY_RECORD);
      const { harness } = build({ state: port });

      const started = await harness.start(spec(), runner({}), {} as never);

      expect(started.ok).toBe(true);
      expect(port.damaged()).toEqual([]);
      expect(changed).toEqual([]);
      expect(await memory.readText('/fy/state/claude-code/launch-settings/f1.json')).toBeUndefined();
    });
  }
});

describe('F-0422 Claude Code records what a launch ran under and compares it with its settings now', () => {
  /** A setting value and a path: neither may be kept in the record or leave in an answer. */
  const SECRET = 'sk-live-W2C-claude-0123456789';
  type Config = { permissionMode: 'auto' | 'skip'; settings: Map<string, unknown>; hooks: Map<string, unknown> };
  const configured = (): Config => ({
    permissionMode: 'auto',
    settings: new Map([['base', { settings: { env: { API_TOKEN: SECRET }, model: 'opus' } }]]),
    hooks: new Map([['audit', { hooks: { PostToolUse: [{ command: `echo ${SECRET}` }] } }]]),
  });
  const over = (config: Config, state: StatePort) =>
    build({
      state,
      config: {
        file: () => ({ searchPaths: [], permissionMode: config.permissionMode }),
        collection: definition =>
          definition === CLAUDE_CODE_SETTINGS
            ? config.settings
            : definition === CLAUDE_CODE_HOOKS
              ? config.hooks
              : new Map(),
      },
    });
  const launchOf = async (config: Config, folder = new MemoryStateFolder()) => {
    const state = folder.port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const built = over(config, state);
    expect((await built.harness.start(spec(), runner({}), {} as never)).ok).toBe(true);
    return { ...built, folder, state };
  };

  test('F-0422 a start records one fingerprint per section in state/claude-code/launch-settings/<ferret>.json, values-free', async () => {
    const { folder } = await launchOf(configured());

    const raw = folder.raw(CLAUDE_CODE_LAUNCH_SETTINGS, FERRET) ?? '';
    const record = JSON.parse(raw) as { format: number; sections: Record<string, string> };

    expect(record.format).toBe(1);
    expect(Object.keys(record.sections).toSorted()).toEqual(['fixed-layer', 'hooks', 'permission-mode', 'settings']);
    for (const digest of Object.values(record.sections)) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    for (const value of [SECRET, '/work', 'auto', 'opus', 'API_TOKEN', HOME]) expect(raw).not.toContain(value);
  });

  test('F-0422 a launch reads the configuration once, so the home, the argv and the record cannot describe different settings', async () => {
    const config = configured();
    const reads = { file: 0, settings: 0, hooks: 0 };
    const state = new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const { harness } = build({
      state,
      config: {
        file: () => (reads.file++, { searchPaths: [], permissionMode: config.permissionMode }),
        collection: definition => {
          if (definition === CLAUDE_CODE_SETTINGS) return reads.settings++, config.settings;
          if (definition === CLAUDE_CODE_HOOKS) return reads.hooks++, config.hooks;
          return new Map();
        },
      },
    });

    expect((await harness.start(spec(), runner({}), {} as never)).ok).toBe(true);
    expect(reads).toEqual({ file: 1, settings: 1, hooks: 1 });
    expect((await harness.resume(spec(), runner({}), {} as never, 'a-conversation-1')).ok).toBe(true);
    expect(reads).toEqual({ file: 2, settings: 2, hooks: 2 });
  });

  test('F-0422 nothing changed since the launch is current; the effort a launch asked for is not a setting', async () => {
    const config = configured();
    const folder = new MemoryStateFolder();
    const state = folder.port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const { harness } = over(config, state);
    await harness.start(spec({ effort: 'high' }), runner({}), {} as never);

    expect(await harness.launchSettings(FERRET)).toEqual({ kind: 'current' });
  });

  test('F-0422 each change since the launch names its section, and only its section', async () => {
    const config = configured();
    const { harness } = await launchOf(config);

    config.hooks = new Map([['audit', { hooks: { PostToolUse: [{ command: 'echo changed' }] } }]]);
    const hooks = await harness.launchSettings(FERRET);
    config.settings = new Map([['base', { settings: { model: 'sonnet' } }]]);
    const both = await harness.launchSettings(FERRET);
    config.settings = configured().settings;
    config.hooks = configured().hooks;
    config.permissionMode = 'skip';
    const mode = await harness.launchSettings(FERRET);

    expect(hooks).toEqual({ kind: 'drifted', sections: ['hooks'] });
    expect(both).toEqual({ kind: 'drifted', sections: ['settings', 'hooks'] });
    // The permission mode is in the fixed layer too, so a mode change moves both.
    expect(mode).toEqual({ kind: 'drifted', sections: ['permission-mode', 'fixed-layer'] });
  });

  test('F-0422 a resume records afresh, so a ferret relaunched on the new settings is current again', async () => {
    const config = configured();
    const { harness } = await launchOf(config);
    config.permissionMode = 'skip';
    expect((await harness.launchSettings(FERRET)).kind).toBe('drifted');

    await harness.resume(spec(), runner({}), {} as never, 'conv-1');

    expect(await harness.launchSettings(FERRET)).toEqual({ kind: 'current' });
  });

  test('F-0422 no record, a damaged one, one too large to be a record, or an id that is not a plain name is unknown', async () => {
    const folder = new MemoryStateFolder();
    const reads: string[] = [];
    const port = folder.port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const state: StatePort = {
      ...port,
      read: async (file, name) => (reads.push(name ?? ''), await port.read(file, name)),
      version: async (file, name) => (reads.push(`version:${name ?? ''}`), await port.version(file, name)),
    };
    const { harness } = over(configured(), state);
    const never = await harness.launchSettings(FERRET);
    folder.plant(CLAUDE_CODE_LAUNCH_SETTINGS, `{"format":1,"sections":{"settings":"${SECRET}"}}`, FERRET);
    const damaged = await harness.launchSettings(FERRET);
    folder.plant(CLAUDE_CODE_LAUNCH_SETTINGS, `{"format":1,"pad":"${'x'.repeat(8 * 1024)}"}`, FERRET);
    const readsBefore = reads.length;
    const oversized = await harness.launchSettings(FERRET);
    const crooked = await harness.launchSettings('../f2' as FerretId);

    for (const answer of [never, damaged, oversized, crooked]) expect(answer).toEqual({ kind: 'unknown' });
    expect(JSON.stringify(damaged)).not.toContain(SECRET);
    // Bounded: the oversized record is sized by one lstat and never read; a crooked id never reaches the state port.
    expect(reads.slice(readsBefore)).toEqual([`version:${FERRET}`]);
  });

  test('F-0422 a state port that faults while reading is unknown, and what it threw is dropped unread', async () => {
    const port = new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const { harness } = over(configured(), {
      ...port,
      version: async () => {
        throw new Error(`EIO at ${HOME}: ${SECRET}`);
      },
    });

    const answer = await harness.launchSettings(FERRET);

    expect(answer).toEqual({ kind: 'unknown' });
    expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test('F-0422 a record that cannot be written never fails the launch, and an older launch’s record is not left to answer', async () => {
    const config = configured();
    const { harness, folder } = await launchOf(config);
    config.permissionMode = 'skip';
    const port = folder.port([CLAUDE_CODE_LAUNCH_SETTINGS]);
    const failing = over(config, {
      ...port,
      write: async () => {
        throw new Error(`disk full at ${HOME} ${SECRET}`);
      },
    });

    const started = await failing.harness.start(spec(), runner({}), {} as never);

    expect(started.ok).toBe(true);
    expect(folder.raw(CLAUDE_CODE_LAUNCH_SETTINGS, FERRET)).toBeUndefined();
    expect(await harness.launchSettings(FERRET)).toEqual({ kind: 'unknown' });
  });
});
