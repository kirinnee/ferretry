import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LaunchSpec, Runner } from '@ferretry/core-ferrets/contract';
import type { FerretId, SpawnResult } from '@ferretry/kernel/contract';
import { type Instant, ok } from '@ferretry/std';
import { ClaudeHarness } from '../../daemon/adapters/claude-harness.ts';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
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

function build(options: { located?: boolean; tmux?: (args: readonly string[]) => number } = {}) {
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
    config: { file: () => ({ searchPaths: [], permissionMode: 'auto' }), collection: () => new Map() } as never,
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

  test('start runs claude in the home with a session id the daemon assigned, and remembers the pane', async () => {
    const { harness, panes } = build();
    const started: { command?: readonly string[]; cwd?: string } = {};

    const result = await harness.start(spec({ model: 'claude-opus-5-5' }), runner(started), {} as never);

    expect(result.ok && result.value.harnessConversation).toBe('conv-1');
    expect(started.cwd).toBe('/work');
    expect(started.command?.slice(0, 3)).toEqual(['env', `CLAUDE_CONFIG_DIR=${HOME}`, '/opt/bin/claude']);
    expect(started.command).toContain('--session-id');
    expect(started.command?.slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
    expect(panes.require(FERRET)).toBe('%7');
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

  test('dialogs.current finds nothing on an empty pane and answer refuses a prompt that is gone', async () => {
    const { harness, panes } = build();
    panes.remember(FERRET, '%7');

    expect(await harness.dialogs.current(FERRET)).toBeUndefined();
    expect(await harness.dialogs.answer(FERRET, '0123456789abcdef', '1')).toMatchObject({ status: 'refused' });
  });
});
