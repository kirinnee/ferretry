import { describe, expect, test } from 'bun:test';
import type { LaunchSpec, Runner } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, RootHandle, SpawnResult } from '@ferretry/kernel/contract';
import { type Instant, ok } from '@ferretry/std';
import { ClaudeHarness } from '../../daemon/adapters/claude-harness.ts';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';

const FERRET = 'f1' as FerretId;
const HOME = '/state/claude-code/agent-homes/f1';
const T = '2026-11-01T10:00:00.000Z' as Instant;

/** A home on a map: it resolves only names inside itself, which is what the real root does. */
function fakeRoot(files: Map<string, string>): RootHandle {
  return {
    resolve: (relative: string) =>
      relative.includes('..') ? { ok: false, error: 'outside' } : ok(`${HOME}/${relative}` as FencedPath),
    readText: async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error('no such file');
      return text;
    },
    writeText: async (path: string, text: string) => {
      files.set(path, text);
    },
    list: async (path: string) => {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]),
        ),
      ];
    },
    stat: async (path: string) => (files.has(path) ? { kind: 'file', size: 1, modified: T } : undefined),
  } as unknown as RootHandle;
}

function build(options: { located?: boolean; tmux?: (args: readonly string[]) => number } = {}) {
  const files = new Map<string, string>();
  const tmux: string[][] = [];
  const panes = new PaneDirectory();
  const harness = new ClaudeHarness({
    roots: { root: () => fakeRoot(files) } as never,
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
        await fn({ text: (s: string) => s.replaceAll('SECRET', '******'), lines: (l: unknown) => l, cells: (g: unknown) => g }),
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
  });
  return { harness, files, tmux, panes };
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
  test('discover finds claude and its version without reading any sign-in file', async () => {
    expect(await build().harness.discover()).toEqual({ found: true, binary: '/opt/bin/claude', version: '2.1.220' });
    expect((await build({ located: false }).harness.discover()).found).toBe(false);
  });

  test('prepareHome writes instructions, settings and MCP inside the ferret home and nowhere else', async () => {
    const { harness, files } = build();

    const plan = await harness.prepareHome(spec({ effort: 'high' }));

    expect([...files.keys()].every(path => path.startsWith(`${HOME}/`))).toBe(true);
    expect(plan.files.length).toBe(files.size);
    expect([...files.values()].some(text => text.includes('Be brief.'))).toBe(true);
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

  test('the transcript is read from the newest conversation in the home, masked as it leaves', async () => {
    const { harness, files } = build();
    files.set(
      `${HOME}/projects/p/c.jsonl`,
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: T, message: { content: 'my SECRET here' } })}\n${JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: T,
        message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } },
      })}`,
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
