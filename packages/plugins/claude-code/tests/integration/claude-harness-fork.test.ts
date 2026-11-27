/**
 * Forking a Claude Code conversation (`Harness.fork`): the REAL kernel roots over a temp folder and SYNTHETIC transcripts
 * only (never a real `~/.claude`). What is proved: a cut at a turn holds exactly that turn and everything before it under a
 * fresh id; it lands in the pool under the spelling of the folder the new ferret will work in, where `hasConversation`
 * finds it; the source file is byte-, mtime- and inode-identical afterwards; every refusal writes nothing; and `discard`
 * removes only the file this fork made.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
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

const SOURCE = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const NEW_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const FOLDER = '/work/app';
const NEW_FOLDER = '/work/app-fork';
let fixture: string;
let fyHome: string;
let fresh: string[];

const POOL = { state: CLAUDE_CODE_HISTORY_POOL.name, entries: CLAUDE_CODE_HISTORY_ENTRIES };
const homeOf = (ferret: string) => join(fyHome, 'state/claude-code/agent-homes', ferret);
const pool = (...parts: string[]) => join(fyHome, 'state/claude-code/history-pool', ...parts);
const spelled = (folder: string) => folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');
const sourceFile = () => pool(`projects/${spelled(FOLDER)}/${SOURCE}.jsonl`);

beforeEach(async () => {
  fresh = [NEW_ID];
  fixture = await mkdtemp(join(tmpdir(), 'claude-fork-'));
  fyHome = join(fixture, 'fy-home');
  await mkdir(join(fyHome, 'state/claude-code/agent-homes'), { recursive: true });
  for (const folder of ['', 'state', 'state/claude-code', 'state/claude-code/agent-homes'])
    await chmod(join(fyHome, folder), 0o700);
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'claude-code' },
    ['agent-homes', 'harness-history'],
    { historyPool: POOL, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] },
  );
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function build() {
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'claude-code', worktrees: join(fixture, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { historyPool: POOL, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] },
  );
  return new ClaudeHarness({
    selected: async () => ({ settings: { has: () => true }, hooks: { has: () => true } }) as never,
    roots,
    config: {
      fileState: () => ({ state: 'valid', inEffect: true, sentences: [] }),
      file: () => ({ searchPaths: [], permissionMode: 'auto' }),
      collection: () => new Map(),
    } as never,
    state: new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]),
    spawn: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }) } as never,
    clock: { sleep: async () => {}, after: () => () => {}, nowMs: () => Date.now() } as never,
    redaction: { read: async (fn: (scope: unknown) => unknown) => await fn({ text: (s: string) => s }) } as never,
    location: {} as never,
    probe: {} as never,
    update: {} as never,
    panes: new PaneDirectory(),
    permission: {} as never,
    dialog: {} as never,
    newConversationId: () => fresh.shift() ?? SOURCE,
    historyHome: async () => join(fixture, 'owner/.claude'),
  });
}

const spec = (ferret: string, folder: string): LaunchSpec =>
  ({
    ferret: ferret as FerretId,
    name: ferret,
    role: 'lead',
    harness: 'claude-code',
    folder,
    home: homeOf(ferret),
    instructions: [],
    parts: [],
  }) as unknown as LaunchSpec;

const at = (n: number) => `2026-11-01T10:${String(n).padStart(2, '0')}:00.000Z`;
const prompt = (n: number, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: `p${n}`,
  sessionId: SOURCE,
  timestamp: at(n * 2),
  message: { role: 'user', content: `question ${n}` },
  ...extra,
});
const answer = (n: number, content: unknown = [{ type: 'text', text: `answer ${n}` }]) => ({
  type: 'assistant',
  uuid: `a${n}`,
  sessionId: SOURCE,
  timestamp: at(n * 2 + 1),
  message: { role: 'assistant', content },
});

/** A ferret with a five-turn conversation in the pool: `<home>/conversation.json` names it, as a started ferret's does. */
async function seed(records: readonly unknown[], tail = ''): Promise<void> {
  const harness = build();
  await harness.prepareHome(spec('src', FOLDER));
  await writeFile(join(homeOf('src'), 'conversation.json'), JSON.stringify({ format: 1, id: SOURCE, cwd: FOLDER }));
  await mkdir(join(fyHome, 'state/claude-code/history-pool', `projects/${spelled(FOLDER)}`), { recursive: true });
  await writeFile(sourceFile(), `${records.map(r => JSON.stringify(r)).join('\n')}\n${tail}`);
}
const five = () => [1, 2, 3, 4, 5].flatMap(n => [prompt(n), answer(n)]);

const lines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>);
const poolFiles = async () =>
  (await readdir(pool('projects'), { recursive: true })).filter(name => name.endsWith('.jsonl')).sort();

describe('Claude Code fork', () => {
  test('a cut at turn 3 of 5 holds exactly turns 1..3 under a fresh id, found by hasConversation, and leaves the source untouched', async () => {
    await seed(five());
    const before = { bytes: await readFile(sourceFile()), stat: await stat(sourceFile()) };
    const harness = build();
    const plan = await harness.fork!('src' as FerretId, { turn: 3 }, { folder: FOLDER });
    expect(plan.harnessConversation).toBe(NEW_ID);
    expect(String(plan.from)).toBe('src');
    const copy = await lines(pool(`projects/${spelled(FOLDER)}/${NEW_ID}.jsonl`));
    expect(copy.map(r => r.uuid)).toEqual(['p1', 'a1', 'p2', 'a2', 'p3', 'a3']);
    expect(copy.every(r => r.sessionId === NEW_ID)).toBe(true);
    await harness.prepareHome(spec('fork', FOLDER));
    expect(await harness.hasConversation(spec('fork', FOLDER), NEW_ID)).toBe(true);
    const after = await stat(sourceFile());
    expect(await readFile(sourceFile())).toEqual(before.bytes);
    expect(after.mtimeMs).toBe(before.stat.mtimeMs);
    expect(after.ino).toBe(before.stat.ino);
    expect((await lstat(sourceFile())).isSymbolicLink()).toBe(false);
  });

  test('a fork into another folder is written under THAT folder’s spelling, so a new worktree resumes it', async () => {
    await seed(five());
    const harness = build();
    const plan = await harness.fork!('src' as FerretId, { turn: 2 }, { folder: NEW_FOLDER });
    expect((await lstat(pool(`projects/${spelled(NEW_FOLDER)}/${NEW_ID}.jsonl`))).isFile()).toBe(true);
    await harness.prepareHome(spec('fork', NEW_FOLDER));
    expect(await harness.hasConversation(spec('fork', NEW_FOLDER), plan.harnessConversation)).toBe(true);
    expect(await poolFiles()).toEqual(
      [`${spelled(FOLDER)}/${SOURCE}.jsonl`, `${spelled(NEW_FOLDER)}/${NEW_ID}.jsonl`].sort(),
    );
  });

  test('with no turn named the whole conversation is cut, and a record still being written is not carried', async () => {
    await seed(five(), '{"type":"user","uuid":"half');
    const harness = build();
    const plan = await harness.fork!('src' as FerretId, undefined, { folder: FOLDER });
    const copy = await lines(pool(`projects/${spelled(FOLDER)}/${plan.harnessConversation}.jsonl`));
    expect(copy).toHaveLength(10);
    expect(plan.at).toBeUndefined();
  });

  test('a cut at an entry holds the records through it, and an entry that is not in the named turn is refused', async () => {
    await seed(five());
    const harness = build();
    await harness.fork!('src' as FerretId, { turn: 2, entry: 'a2' }, { folder: FOLDER });
    expect((await lines(pool(`projects/${spelled(FOLDER)}/${NEW_ID}.jsonl`))).map(r => r.uuid)).toEqual([
      'p1',
      'a1',
      'p2',
      'a2',
    ]);
    const files = await poolFiles();
    fresh = ['1c8f5d2b-2e3a-4d4c-8b9f-8a7e6d5c4b32'];
    await expect(harness.fork!('src' as FerretId, { turn: 4, entry: 'a2' }, { folder: FOLDER })).rejects.toThrow(
      'is in turn 2, not turn 4',
    );
    await expect(harness.fork!('src' as FerretId, { turn: 2, entry: 'nope' }, { folder: FOLDER })).rejects.toThrow(
      'no entry nope',
    );
    expect(await poolFiles()).toEqual(files);
  });

  test('a turn the conversation does not have, a turn before the first, or a cut inside an unanswered tool call is refused with nothing written', async () => {
    await seed([
      prompt(1),
      answer(1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      {
        type: 'user',
        uuid: 'r1',
        sessionId: SOURCE,
        timestamp: at(9),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      answer(2),
    ]);
    const harness = build();
    const files = await poolFiles();
    await expect(harness.fork!('src' as FerretId, { turn: 2 }, { folder: FOLDER })).rejects.toThrow(
      'turn 2 does not exist: this conversation has 1 turn',
    );
    await expect(harness.fork!('src' as FerretId, { turn: 0 }, { folder: FOLDER })).rejects.toThrow('count from 1');
    await expect(harness.fork!('src' as FerretId, { turn: 1, entry: 'a1' }, { folder: FOLDER })).rejects.toThrow(
      'inside a tool call',
    );
    expect(await poolFiles()).toEqual(files);
  });

  test('a ferret with no conversation on disk, and a folder that is not absolute, are refused with nothing written', async () => {
    await mkdir(homeOf('empty'), { recursive: true });
    await seed(five());
    const harness = build();
    const files = await poolFiles();
    await expect(harness.fork!('empty' as FerretId, { turn: 1 }, { folder: FOLDER })).rejects.toThrow(
      'no conversation on disk',
    );
    await expect(harness.fork!('src' as FerretId, { turn: 1 }, { folder: 'relative/dir' })).rejects.toThrow('absolute');
    expect(await poolFiles()).toEqual(files);
  });

  test('a new id that is already a conversation is never written over', async () => {
    await seed(five());
    const harness = build();
    await mkdir(pool(`projects/${spelled(FOLDER)}`), { recursive: true });
    await writeFile(pool(`projects/${spelled(FOLDER)}/${NEW_ID}.jsonl`), 'someone else’s conversation\n');
    await expect(harness.fork!('src' as FerretId, { turn: 1 }, { folder: FOLDER })).rejects.toThrow();
    expect(await readFile(pool(`projects/${spelled(FOLDER)}/${NEW_ID}.jsonl`), 'utf8')).toBe(
      'someone else’s conversation\n',
    );
  });

  test('discard removes the new copy and only it; a file put at that name since is left, and the source is never touched', async () => {
    await seed(five());
    const harness = build();
    const target = pool(`projects/${spelled(FOLDER)}/${NEW_ID}.jsonl`);
    const before = await readFile(sourceFile());
    const plan = await harness.fork!('src' as FerretId, { turn: 3 }, { folder: FOLDER });
    await plan.discard!();
    expect(await lstat(target).catch(() => undefined)).toBeUndefined();
    expect(await readFile(sourceFile())).toEqual(before);
    // A second discard has nothing to do.
    await plan.discard!();

    fresh = [NEW_ID];
    const again = await harness.fork!('src' as FerretId, { turn: 3 }, { folder: FOLDER });
    // Written beside and renamed over, so the old file still exists and no inode number is reused.
    await writeFile(`${target}.new`, 'a different file at the same name\n');
    await rename(`${target}.new`, target);
    await again.discard!().catch(() => undefined);
    expect(await readFile(target, 'utf8')).toBe('a different file at the same name\n');
    expect(await readFile(sourceFile())).toEqual(before);
  });

  test('a source reached through a link in the pool is never followed out of it', async () => {
    await seed(five());
    const outside = join(fixture, 'outside.jsonl');
    await writeFile(outside, `${JSON.stringify(prompt(1))}\n`);
    await rm(sourceFile());
    await symlink(outside, sourceFile());
    const harness = build();
    await expect(harness.fork!('src' as FerretId, { turn: 1 }, { folder: FOLDER })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe(`${JSON.stringify(prompt(1))}\n`);
  });
});
