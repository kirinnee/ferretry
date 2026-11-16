/**
 * Claude Code on the shared history pool (docs/design/shared-history.md): the REAL kernel roots over a temp folder, so the
 * links, the moves into the pool and every refusal are the production ones. What is proved: each history entry of a home
 * becomes a link to the plugin's one pool; a relaunch leaves a correct link alone; two ferrets' real `projects/<slug>/`
 * folders merge into the pool and a name the pool already holds is kept aside, never overwritten; a pooling that cannot
 * be made lets the launch go on with one sentence; a conversation any ferret wrote is found (and resumed) through the
 * pool; and copy-on-link reads the owner's history and never writes it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec, Runner } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { type Instant, ok } from '@ferretry/std';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import {
  CLAUDE_CODE_AGENT_HOMES,
  CLAUDE_CODE_HISTORY_ENTRIES,
  CLAUDE_CODE_HISTORY_POOL,
  CLAUDE_CODE_LAUNCH_SETTINGS,
} from '../../contract/index.ts';
import { ClaudeHarness } from '../../daemon/adapters/claude-harness.ts';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const T = '2026-11-01T10:00:00.000Z' as Instant;
let fixture: string;
let fyHome: string;
let owner: string;
const messages: string[] = [];

beforeEach(async () => {
  messages.length = 0;
  fixture = await mkdtemp(join(tmpdir(), 'claude-pool-'));
  fyHome = join(fixture, 'fy-home');
  owner = join(fixture, 'owner/.claude');
  await mkdir(owner, { recursive: true });
  await mkdir(join(fyHome, 'state/claude-code/agent-homes'), { recursive: true });
  for (const folder of ['', 'state', 'state/claude-code', 'state/claude-code/agent-homes'])
    await chmod(join(fyHome, folder), 0o700);
  // The daemon makes every base at boot, the pool's among them (for a plugin that declares one).
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'claude-code' },
    ['agent-homes', 'harness-history'],
    { historyPool: POOL_PERMISSION, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] },
  );
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

const POOL_PERMISSION = { state: CLAUDE_CODE_HISTORY_POOL.name, entries: CLAUDE_CODE_HISTORY_ENTRIES };
const homeOf = (ferret: string) => join(fyHome, 'state/claude-code/agent-homes', ferret);
const pool = (...parts: string[]) => join(fyHome, 'state/claude-code/history-pool', ...parts);

/** The harness over the real roots; `pooled: false` declares no pool (a plugin the kernel does not let pool). */
function build(options: { pooled?: boolean } = {}) {
  const fs = nodeFs(() => crypto.randomUUID());
  const roots = rootsPortFor(
    fs,
    { home: fyHome, plugin: 'claude-code', worktrees: join(fixture, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    options.pooled === false
      ? {}
      : { historyPool: POOL_PERMISSION, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] },
  );
  const harness = new ClaudeHarness({
    selected: async () => ({ settings: { has: () => true }, hooks: { has: () => true } }) as never,
    roots,
    config: { file: () => ({ searchPaths: [], permissionMode: 'auto' }), collection: () => new Map() } as never,
    state: new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]),
    spawn: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }) } as never,
    clock: { sleep: async () => {}, after: () => () => {} } as never,
    redaction: { read: async (fn: (scope: unknown) => unknown) => await fn({ text: (s: string) => s }) } as never,
    location: {
      locate: async () => ({ outcome: 'located', path: '/opt/bin/claude', rule: 'x', declaredBy: 'PATH' }),
    } as never,
    probe: { version: async () => ({ state: 'ok', version: '2.1.220' }) } as never,
    update: {} as never,
    panes: new PaneDirectory(),
    permission: {} as never,
    dialog: {} as never,
    newConversationId: () => CONVERSATION,
    historyHome: async () => owner,
    warn: message => void messages.push(message),
  });
  return { harness, fs };
}

const spec = (ferret: string, more: Record<string, unknown> = {}): LaunchSpec =>
  ({
    ferret: ferret as FerretId,
    name: ferret,
    role: 'lead',
    harness: 'claude-code',
    folder: '/work',
    home: homeOf(ferret),
    instructions: [],
    parts: [],
    ...more,
  }) as unknown as LaunchSpec;

const runner = (): Runner =>
  ({ key: 'tmux', start: async () => ok({ handle: '%7', startedAt: T }), stop: async () => {} }) as unknown as Runner;

const exists = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined;

describe('Claude Code and the shared history pool', () => {
  test('a launch links every history entry of the home to the one pool, and leaves a correct link alone next time', async () => {
    const { harness } = build();
    await harness.prepareHome(spec('f1'));
    for (const { name } of CLAUDE_CODE_HISTORY_ENTRIES) {
      expect((await lstat(join(homeOf('f1'), name))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(homeOf('f1'), name))).toEndWith(`/state/claude-code/history-pool/${name}`);
    }
    expect((await lstat(pool('projects'))).isDirectory()).toBe(true);
    expect((await lstat(pool('history.jsonl'))).isFile()).toBe(true);
    // Not a history entry: the ferret's own, a real file, never a link.
    expect((await lstat(join(homeOf('f1'), 'settings.json'))).isSymbolicLink()).toBe(false);
    // A second preparation (every start and resume) is quiet and changes no link.
    const before = await Promise.all(CLAUDE_CODE_HISTORY_ENTRIES.map(e => readlink(join(homeOf('f1'), e.name))));
    await harness.prepareHome(spec('f1'));
    expect(await Promise.all(CLAUDE_CODE_HISTORY_ENTRIES.map(e => readlink(join(homeOf('f1'), e.name))))).toEqual(
      before,
    );
    expect(messages).toEqual([]);
  });

  test('two ferrets that already hold real projects folders merge into the pool; a name the pool has is kept aside, never overwritten', async () => {
    for (const ferret of ['f1', 'f2']) await mkdir(join(homeOf(ferret), 'projects/-work'), { recursive: true });
    await writeFile(join(homeOf('f1'), 'projects/-work/a.jsonl'), 'a from f1\n');
    await writeFile(join(homeOf('f1'), 'projects/-work/same.jsonl'), 'same, f1\n');
    await writeFile(join(homeOf('f2'), 'projects/-work/b.jsonl'), 'b from f2\n');
    await writeFile(join(homeOf('f2'), 'projects/-work/same.jsonl'), 'same, f2\n');
    await mkdir(join(homeOf('f2'), 'projects/-other'), { recursive: true });
    await writeFile(join(homeOf('f2'), 'projects/-other/c.jsonl'), 'c from f2\n');
    const { harness } = build();
    await harness.prepareHome(spec('f1'));
    await harness.prepareHome(spec('f2'));
    // Both homes read every conversation through their `projects` link.
    for (const ferret of ['f1', 'f2']) {
      expect((await lstat(join(homeOf(ferret), 'projects'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(homeOf(ferret), 'projects/-work/a.jsonl'), 'utf8')).toBe('a from f1\n');
      expect(await readFile(join(homeOf(ferret), 'projects/-work/b.jsonl'), 'utf8')).toBe('b from f2\n');
      expect(await readFile(join(homeOf(ferret), 'projects/-other/c.jsonl'), 'utf8')).toBe('c from f2\n');
    }
    // First in the pool stays; the second one's file is kept aside under its ferret, byte for byte.
    expect(await readFile(pool('projects/-work/same.jsonl'), 'utf8')).toBe('same, f1\n');
    expect(await readFile(pool('.conflicts/f2/projects/-work/same.jsonl'), 'utf8')).toBe('same, f2\n');
    expect(messages.join('\n')).toContain('kept in the pool');
    // No real `projects` folder is left behind in either home.
    expect((await readdir(homeOf('f2'))).filter(name => name.startsWith('projects'))).toEqual(['projects']);
  });

  test('a pooling that cannot be made lets the launch go on with the ferret’s own history, and says so in one sentence', async () => {
    await mkdir(join(homeOf('f1'), 'projects/-work'), { recursive: true });
    await writeFile(join(homeOf('f1'), 'projects/-work/mine.jsonl'), 'mine\n');
    const { harness } = build({ pooled: false });
    const plan = await harness.prepareHome(spec('f1'));
    expect(plan.files.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('goes on with its own history');
    // Nothing of the home was touched.
    expect((await lstat(join(homeOf('f1'), 'projects'))).isDirectory()).toBe(true);
    expect(await readFile(join(homeOf('f1'), 'projects/-work/mine.jsonl'), 'utf8')).toBe('mine\n');
    const started = await harness.start(spec('f1'), runner(), {} as never);
    expect(started.ok).toBe(true);
  });

  test('hasConversation finds a conversation another ferret wrote, through the pool, and proves an unknown one absent', async () => {
    const { harness } = build();
    await harness.prepareHome(spec('f1'));
    await harness.prepareHome(spec('f2'));
    // f1 writes a conversation (Claude writes through its `projects` link into the pool).
    await mkdir(join(homeOf('f1'), 'projects/-work'), { recursive: true });
    await writeFile(join(homeOf('f1'), `projects/-work/${CONVERSATION}.jsonl`), '{"type":"user"}\n');
    expect(await harness.hasConversation(spec('f2'), CONVERSATION)).toBe(true);
    // Under another spelling of the folder: Claude may still find it, so the harness will not say it is absent.
    await mkdir(join(homeOf('f1'), 'projects/-elsewhere'), { recursive: true });
    await writeFile(join(homeOf('f1'), 'projects/-elsewhere/1c8f5d2b-2e3a-4d4c-8b9f-8a7e6d5c4b32.jsonl'), '{}\n');
    expect(await harness.hasConversation(spec('f2'), '1c8f5d2b-2e3a-4d4c-8b9f-8a7e6d5c4b32')).toBeUndefined();
    expect(await harness.hasConversation(spec('f2'), '2d9a6e3c-3f4b-4e5d-9ca0-9b8f7e6d5c43')).toBe(false);
  });

  test('a pooled ferret reads the transcript of its own conversation through the pool', async () => {
    const { harness } = build();
    await harness.start(spec('f1'), runner(), {} as never);
    await mkdir(join(homeOf('f1'), 'projects/-work'), { recursive: true });
    await writeFile(
      join(homeOf('f1'), `projects/-work/${CONVERSATION}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`,
    );
    const stamp = await harness.transcriptStamp('f1' as FerretId);
    expect(stamp?.size).toBeGreaterThan(0);
    expect((await harness.transcript.read('f1' as FerretId)).length).toBeGreaterThan(0);
  });

  test('copy-on-link copies the owner’s transcript into the pool at the same path and never touches the original', async () => {
    await mkdir(join(owner, 'projects/-work'), { recursive: true });
    const source = join(owner, `projects/-work/${CONVERSATION}.jsonl`);
    await writeFile(source, '{"type":"user","message":{"role":"user","content":"mine"}}\n');
    await utimes(source, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    const before = {
      bytes: await readFile(source),
      stat: await stat(source),
      names: await readdir(join(owner, 'projects/-work')),
    };
    const { harness } = build();
    await harness.prepareHome(spec('f1'));
    const copied = await harness.importConversation({
      id: CONVERSATION,
      source: `projects/-work/${CONVERSATION}.jsonl`,
    });
    expect(copied.ok).toBe(true);
    expect(await readFile(pool(`projects/-work/${CONVERSATION}.jsonl`))).toEqual(before.bytes);
    // The original: same bytes, same mtime, same inode, nothing added beside it, never a link.
    const after = await stat(source);
    expect(await readFile(source)).toEqual(before.bytes);
    expect(after.mtimeMs).toBe(before.stat.mtimeMs);
    expect(after.ino).toBe(before.stat.ino);
    expect((await lstat(source)).isSymbolicLink()).toBe(false);
    expect(await readdir(join(owner, 'projects/-work'))).toEqual(before.names);
    expect(await readdir(owner)).toEqual(['projects']);
    // The ferret now resumes the copy rather than starting anew.
    expect(await harness.hasConversation(spec('f1'), CONVERSATION)).toBe(true);
    // Asked again, a name the pool holds is never overwritten (the pooled copy may have moved on).
    await writeFile(pool(`projects/-work/${CONVERSATION}.jsonl`), 'the ferret continued\n');
    expect(
      (await harness.importConversation({ id: CONVERSATION, source: `projects/-work/${CONVERSATION}.jsonl` })).ok,
    ).toBe(true);
    expect(await readFile(pool(`projects/-work/${CONVERSATION}.jsonl`), 'utf8')).toBe('the ferret continued\n');
  });

  test('copy-on-link refuses a source that is not this harness’s transcript of that id, and a file that is gone', async () => {
    const { harness } = build();
    await harness.prepareHome(spec('f1'));
    for (const source of [
      `../projects/-work/${CONVERSATION}.jsonl`,
      `projects/-work/other-${CONVERSATION}.jsonl`,
      `settings.json`,
      `projects/-work/${CONVERSATION}.jsonl/../x`,
      `.credentials.json`,
    ]) {
      const refused = await harness.importConversation({ id: CONVERSATION, source });
      expect(refused.ok).toBe(false);
    }
    const gone = await harness.importConversation({ id: CONVERSATION, source: `projects/-work/${CONVERSATION}.jsonl` });
    expect(gone).toMatchObject({ ok: false });
    expect(await exists(pool('projects/-work'))).toBe(false);
  });
});
