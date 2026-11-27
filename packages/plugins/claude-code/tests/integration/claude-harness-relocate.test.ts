/**
 * Packing and unpacking a Claude Code conversation for the move to another machine (`Harness.packConversation`,
 * `Harness.unpackConversation`, C-45 / G15 U14): the REAL kernel roots over temp folders and SYNTHETIC transcripts only
 * (never a real `~/.claude`). "Machine A" and "machine B" are two FY_HOMEs. What is proved: pack on A -> unpack on B shows
 * the same turns through the Conversation reader; no source worktree path and no old id is left in what B holds; a
 * Claude Code version that was not tested is refused with nothing written; every refusal writes nothing; and the REAL
 * installed `claude` resumes the unpacked conversation against a loopback stub (no network, no login, synthetic homes).
 * The REAL `claude --worktree` writes the worktree conversation moved below, and the REAL `claude` resumes it again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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
import { claudeProjectFolder } from '../../daemon/lib/harness/claude-path.ts';
import { PaneDirectory } from '../../daemon/adapters/tmux-pane.ts';

const OLD_ID = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const NEW_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const A_FOLDER = '/srv/machine-a/work/app-wt';
const POOL = { state: CLAUDE_CODE_HISTORY_POOL.name, entries: CLAUDE_CODE_HISTORY_ENTRIES };
const spelled = (folder: string) => folder.replaceAll(/[^a-zA-Z0-9]/gu, '-');

let fixture: string;
let version = '2.1.327';

/** One machine: its own FY_HOME and its own harness over it. */
interface Machine {
  readonly fyHome: string;
  readonly harness: ClaudeHarness;
  readonly homeOf: (ferret: string) => string;
  readonly pool: (...parts: string[]) => string;
}

async function machine(name: string): Promise<Machine> {
  const fyHome = join(fixture, name, 'fy-home');
  await mkdir(join(fyHome, 'state/claude-code/agent-homes'), { recursive: true });
  for (const folder of ['', 'state', 'state/claude-code', 'state/claude-code/agent-homes'])
    await chmod(join(fyHome, folder), 0o700);
  const stores = { historyPool: POOL, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] };
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'claude-code' },
    ['agent-homes', 'harness-history'],
    stores,
  );
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'claude-code', worktrees: join(fixture, name, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    stores,
  );
  const harness = new ClaudeHarness({
    selected: async () => ({ settings: { has: () => true }, hooks: { has: () => true } }) as never,
    roots,
    config: {
      fileState: () => ({ state: 'valid', inEffect: true, sentences: [] }),
      file: () => ({ searchPaths: [], permissionMode: 'auto' }),
      collection: () => new Map(),
    } as never,
    state: new MemoryStateFolder().port([CLAUDE_CODE_LAUNCH_SETTINGS]),
    // `readlink -f` is the one program the move asks of the host, and it is the real one: the link check is a real question.
    spawn: {
      run: async (program: string, args: readonly string[]) => {
        const done = program === 'readlink' ? Bun.spawnSync(['readlink', ...args]) : undefined;
        return { exitCode: done?.exitCode ?? 0, signal: null, stdout: done?.stdout.toString() ?? '', stderr: '' };
      },
    } as never,
    clock: { sleep: async () => {}, after: () => () => {}, nowMs: () => Date.now() } as never,
    redaction: { read: async (fn: (scope: unknown) => unknown) => await fn({ text: (s: string) => s }) } as never,
    location: { locate: async () => ({ outcome: 'located', path: '/synthetic/claude' }) } as never,
    probe: { version: async () => ({ state: 'ok', version }) } as never,
    update: {} as never,
    panes: new PaneDirectory(),
    permission: {} as never,
    dialog: {} as never,
    newConversationId: () => NEW_ID,
    historyHome: async () => join(fixture, name, 'owner/.claude'),
  });
  return {
    fyHome,
    harness,
    homeOf: ferret => join(fyHome, 'state/claude-code/agent-homes', ferret),
    pool: (...parts) => join(fyHome, 'state/claude-code/history-pool', ...parts),
  };
}

const spec = (m: Machine, ferret: string, folder: string, conversation?: string): LaunchSpec =>
  ({
    ferret: ferret as FerretId,
    name: ferret,
    role: 'lead',
    harness: 'claude-code',
    folder,
    home: m.homeOf(ferret),
    instructions: [],
    parts: [],
    ...(conversation === undefined ? {} : { harnessConversation: conversation }),
  }) as unknown as LaunchSpec;

const at = (n: number) => `2026-11-01T10:${String(n).padStart(2, '0')}:00.000Z`;
/** A chained, three-turn conversation as Claude Code writes one: every record names its folder, its id and its parent. */
function conversation(folder: string, id: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const push = (record: Record<string, unknown>): void => {
    const uuid = `00000000-0000-4000-8000-${String(records.length).padStart(12, '0')}`;
    records.push({
      parentUuid: parent,
      isSidechain: false,
      userType: 'external',
      cwd: folder,
      sessionId: id,
      version: '2.1.327',
      uuid,
      timestamp: at(records.length),
      ...record,
    });
    parent = uuid;
  };
  push({
    type: 'system',
    subtype: 'worktree-state',
    worktreeSession: { originalCwd: folder, worktreePath: folder, sessionId: id },
  });
  for (const n of [1, 2, 3]) {
    push({ type: 'user', message: { role: 'user', content: `question ${n}` } });
    push({
      type: 'assistant',
      requestId: `req_${n}`,
      message: {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-stub',
        content: [{ type: 'text', text: `answer ${n}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  }
  // A folder inside the work tree, and one outside it: the first moves with the tree, the second is somewhere else.
  push({ type: 'user', cwd: `${folder}/packages/x`, message: { role: 'user', content: 'question 4' } });
  push({ type: 'user', cwd: '/tmp/elsewhere', message: { role: 'user', content: 'question 5' } });
  return records;
}
const jsonl = (records: readonly unknown[]) => `${records.map(r => JSON.stringify(r)).join('\n')}\n`;

/** A ferret on machine A with its conversation in A's pool, as a started one has. */
async function seedSource(a: Machine, records = conversation(A_FOLDER, OLD_ID)): Promise<void> {
  await a.harness.prepareHome(spec(a, 'src', A_FOLDER));
  await writeFile(join(a.homeOf('src'), 'conversation.json'), JSON.stringify({ format: 1, id: OLD_ID, cwd: A_FOLDER }));
  await mkdir(a.pool(`projects/${spelled(A_FOLDER)}`), { recursive: true });
  await writeFile(a.pool(`projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`), jsonl(records));
}

const poolFiles = async (m: Machine) =>
  (await readdir(m.pool('projects'), { recursive: true }).catch(() => [] as string[]))
    .filter(name => name.endsWith('.jsonl'))
    .sort();
const exists = (path: string) =>
  readdir(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'claude-relocate-'));
  version = '2.1.327';
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('Claude Code pack and unpack for a move', () => {
  test('pack on A then unpack on B shows identical turns through the reader, and hasConversation is true', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const b_folder = join(fixture, 'b/worktrees/app-wt');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    expect(packed.value.relPath).toBe(`projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`);
    expect(new TextDecoder().decode(packed.value.bytes)).toBe(
      await readFile(a.pool(`projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`), 'utf8'),
    );

    const target = spec(b, 'dst', b_folder, NEW_ID);
    const unpacked = await b.harness.unpackConversation!(target, packed.value);
    if (!unpacked.ok) throw new Error(unpacked.error.reason);
    expect(unpacked.value.conversation).toBe(NEW_ID);
    expect(await b.harness.hasConversation(target, NEW_ID)).toBe(true);
    expect(await poolFiles(b)).toEqual([`${spelled(b_folder)}/${NEW_ID}.jsonl`]);

    await writeFile(
      join(b.homeOf('dst'), 'conversation.json'),
      JSON.stringify({ format: 1, id: NEW_ID, cwd: b_folder }),
    );
    const onA = await a.harness.transcript.read('src' as FerretId);
    const onB = await b.harness.transcript.read('dst' as FerretId);
    expect(onA.length).toBeGreaterThan(6);
    expect(onB.map(entry => ({ ...entry, id: undefined }))).toEqual(onA.map(entry => ({ ...entry, id: undefined })));
    expect(onB.map(entry => entry.id)).toEqual(onA.map(entry => entry.id));
  });

  test('no source worktree path and no old id is left anywhere in what B holds; a folder elsewhere is kept', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const bFolder = join(fixture, 'b/worktrees/app-wt');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const done = await b.harness.unpackConversation!(spec(b, 'dst', bFolder, NEW_ID), packed.value);
    expect(done.ok).toBe(true);
    const text = await readFile(b.pool(`projects/${spelled(bFolder)}/${NEW_ID}.jsonl`), 'utf8');
    expect(text).not.toContain(A_FOLDER);
    expect(text).not.toContain(OLD_ID);
    const records = text
      .split('\n')
      .filter(line => line !== '')
      .map(line => JSON.parse(line) as Record<string, any>);
    expect(records.every(r => r.sessionId === NEW_ID)).toBe(true);
    // A worktree binding names the checkout the session was entered from, which is not on B: it is not carried.
    expect(records.some(r => r.type === 'worktree-state')).toBe(false);
    expect(records.at(-2)?.cwd).toBe(`${bFolder}/packages/x`);
    expect(records.at(-1)?.cwd).toBe('/tmp/elsewhere');
  });

  test('with no new id named the packed id is kept and only the folders change', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const bFolder = join(fixture, 'b/worktrees/app-wt');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const done = await b.harness.unpackConversation!(spec(b, 'dst', bFolder), packed.value);
    if (!done.ok) throw new Error(done.error.reason);
    expect(done.value.conversation).toBe(OLD_ID);
    const text = await readFile(b.pool(`projects/${spelled(bFolder)}/${OLD_ID}.jsonl`), 'utf8');
    expect(text).not.toContain(A_FOLDER);
    expect(text).toContain(OLD_ID);
  });

  test('a Claude Code version that was not tested is refused, and nothing is written on B', async () => {
    const a = await machine('a');
    const b = await machine('b');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    // Only the versions a move was measured on are admitted: a version inside the old 2.1.2xx / 2.1.3xx range is refused too.
    for (const odd of ['2.0.9', '2.1.100', '2.1.200', '2.1.328', '2.1.399', '2.1.400', '3.0.1']) {
      version = odd;
      const done = await b.harness.unpackConversation!(spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID), packed.value);
      expect(done.ok).toBe(false);
      if (!done.ok) expect(done.error.reason).toContain(`Claude Code ${odd} was not tested`);
    }
    expect(await poolFiles(b)).toEqual([]);
    expect(await exists(b.homeOf('dst'))).toBe(false);
    for (const measured of ['2.1.281', '2.1.304', '2.1.327']) {
      version = measured;
      const folder = join(fixture, 'b/wt', measured);
      expect((await b.harness.unpackConversation!(spec(b, 'dst', folder, NEW_ID), packed.value)).ok).toBe(true);
    }
  });

  test('a pack that is not a whole conversation, or names an odd path, or ran a subagent, is refused with nothing written', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const good = new TextEncoder().encode(jsonl(conversation(A_FOLDER, OLD_ID)));
    const relPath = `projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`;
    const target = spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID);
    const withSubagent = jsonl([
      ...conversation(A_FOLDER, OLD_ID),
      { type: 'user', sessionId: OLD_ID, toolUseResult: { agentId: 'a1' }, message: { role: 'user', content: 'x' } },
    ]);
    const tries = [
      { bytes: good, relPath: 'projects/../../etc/x.jsonl' },
      { bytes: good, relPath: `projects/${spelled(A_FOLDER)}/${OLD_ID}.txt` },
      { bytes: good, relPath: `/abs/${relPath}` },
      { bytes: new TextEncoder().encode('not json\n'), relPath },
      { bytes: new Uint8Array(), relPath },
      { bytes: new TextEncoder().encode(withSubagent), relPath },
    ];
    for (const packed of tries) expect((await b.harness.unpackConversation!(target, packed)).ok).toBe(false);
    expect(
      (await b.harness.unpackConversation!(spec(b, 'dst', 'relative/dir', NEW_ID), { bytes: good, relPath })).ok,
    ).toBe(false);
    expect((await b.harness.unpackConversation!(spec(b, 'dst', '/x', '../escape'), { bytes: good, relPath })).ok).toBe(
      false,
    );
    expect(await poolFiles(b)).toEqual([]);
    expect(await exists(b.homeOf('dst'))).toBe(false);
    await seedSource(a, JSON.parse(JSON.stringify([...conversation(A_FOLDER, OLD_ID)])));
    await writeFile(a.pool(`projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`), withSubagent);
    const refused = await a.harness.packConversation!('src' as FerretId);
    expect(refused.ok).toBe(false);
    expect((await a.harness.packConversation!('nobody' as FerretId)).ok).toBe(false);
  });

  test('an id that already holds a conversation on B is never written over', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const bFolder = join(fixture, 'b/wt');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const taken = b.pool(`projects/${spelled(bFolder)}/${NEW_ID}.jsonl`);
    await mkdir(b.pool(`projects/${spelled(bFolder)}`), { recursive: true });
    await writeFile(taken, 'someone else’s conversation\n');
    const done = await b.harness.unpackConversation!(spec(b, 'dst', bFolder, NEW_ID), packed.value);
    expect(done.ok).toBe(false);
    expect(await readFile(taken, 'utf8')).toBe('someone else’s conversation\n');
  });
});

/** The ports a test daemon may take (rules: 7480-7499 only). */
const STUB_PORTS = Array.from({ length: 20 }, (_, index) => 7480 + index);

/** A loopback stand-in for the model API: it answers "OK" in the streaming shape and keeps every request body it was sent. */
function stub(): { readonly url: string; readonly bodies: string[]; readonly stop: () => void } {
  const bodies: string[] = [];
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const answer = (streaming: boolean): Response => {
    const message = {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'claude-stub',
      content: [] as unknown[],
      stop_reason: null as string | null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (!streaming)
      return Response.json({ ...message, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' });
    const text =
      sse('message_start', { type: 'message_start', message }) +
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      sse('message_stop', { type: 'message_stop' });
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  };
  for (const port of STUB_PORTS) {
    try {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        fetch: async request => {
          const body = await request.text();
          bodies.push(body);
          if (new URL(request.url).pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 1 });
          return answer((JSON.parse(body || '{}') as { stream?: boolean }).stream === true);
        },
      });
      return { url: `http://127.0.0.1:${port}`, bodies, stop: () => void server.stop(true) };
    } catch {
      // That port is taken: the next one of the allowed range.
    }
  }
  throw new Error('no loopback port of 7480-7499 is free');
}

/** The installed `claude` run in a BUILT environment: nobody's CLAUDE_CONFIG_DIR, no proxy, no real key, only the loopback stub. */
async function runClaude(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly config: string;
  readonly home: string;
  readonly url: string;
}): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  await mkdir(input.home, { recursive: true });
  const child = Bun.spawn(['claude', ...input.args, '--output-format', 'text'], {
    cwd: input.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: Bun.env.PATH ?? '',
      HOME: input.home,
      CLAUDE_CONFIG_DIR: input.config,
      ANTHROPIC_BASE_URL: input.url,
      ANTHROPIC_API_KEY: 'sk-ant-FIXTURE-NOT-A-KEY',
      NO_PROXY: '127.0.0.1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });
  const timer = setTimeout(() => child.kill(), 90_000);
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, out, err };
}

describe('the installed Claude Code resumes an unpacked conversation', () => {
  test('claude -p --resume finds it in the new folder and sends the carried history to a loopback stub', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const bFolder = join(fixture, 'b/worktrees/app-wt');
    await mkdir(bFolder, { recursive: true });
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const target = spec(b, 'dst', bFolder, NEW_ID);
    // The home Claude runs in is the one a launch prepares: its `projects` link reaches the pool the pack was unpacked into.
    await b.harness.prepareHome(target);
    const done = await b.harness.unpackConversation!(target, packed.value);
    if (!done.ok) throw new Error(done.error.reason);

    const server = stub();
    const resume = (id: string) =>
      runClaude({
        args: ['-p', 'and now?', '--resume', id],
        cwd: bFolder,
        config: b.homeOf('dst'),
        home: join(fixture, 'b/home'),
        url: server.url,
      });
    try {
      // The control: a conversation id nobody unpacked is not resumed, so the run below proves the unpacked file did it.
      const missing = await resume('7e3f9a10-5b2c-4d8e-9f01-123456789abc');
      expect(missing.code).not.toBe(0);
      expect(server.bodies.some(body => body.includes('question 1'))).toBe(false);

      const resumed = await resume(NEW_ID);
      expect(resumed.code).toBe(0);
      expect(resumed.out).toContain('OK');
      const sent = server.bodies.find(body => body.includes('and now?'));
      expect(sent).toBeDefined();
      for (const carried of ['question 1', 'answer 1', 'question 3', 'answer 3']) expect(sent).toContain(carried);
      expect(sent).not.toContain(A_FOLDER);
    } finally {
      server.stop();
    }
  }, 120_000);
});

describe('what a move refuses before it writes', () => {
  test('a pack with no real turn in it (metadata only) is refused: Claude would say "No conversation found"', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const metadata = [
      { type: 'worktree-state', worktreeSession: { originalCwd: A_FOLDER, worktreePath: A_FOLDER, sessionId: OLD_ID } },
      { type: 'queue-operation', operation: 'enqueue', sessionId: OLD_ID, content: 'a prompt that never ran' },
      { type: 'last-prompt', sessionId: OLD_ID, lastPrompt: 'a prompt that never ran' },
    ];
    const relPath = `projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`;
    const bytes = new TextEncoder().encode(jsonl(metadata));
    const done = await b.harness.unpackConversation!(spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID), { bytes, relPath });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.reason).toContain('no turn');
    expect(await poolFiles(b)).toEqual([]);
    expect(await exists(b.homeOf('dst'))).toBe(false);
    // The same file packed on A is refused there too, so it never travels.
    await seedSource(a, metadata);
    const packed = await a.harness.packConversation!('src' as FerretId);
    expect(packed.ok).toBe(false);
  });

  test('a record of a kind it does not know that carries a folder of the source is refused, with nothing written', async () => {
    const b = await machine('b');
    const records = [
      ...conversation(A_FOLDER, OLD_ID),
      { type: 'mystery-state', sessionId: OLD_ID, where: `${A_FOLDER}/src` },
    ];
    const bytes = new TextEncoder().encode(jsonl(records));
    const relPath = `projects/${spelled(A_FOLDER)}/${OLD_ID}.jsonl`;
    const done = await b.harness.unpackConversation!(spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID), { bytes, relPath });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.reason).toContain('mystery-state');
    expect(await poolFiles(b)).toEqual([]);
    expect(await exists(b.homeOf('dst'))).toBe(false);
  });

  test('a `projects` link that is not this machine’s pool refuses the unpack and writes nothing', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const bFolder = join(fixture, 'b/wt');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const target = spec(b, 'dst', bFolder, NEW_ID);
    await b.harness.prepareHome(target);
    const decoy = join(fixture, 'decoy');
    // A link Claude would read through, that is not the pool's `projects` folder: a stranger's folder, and the pool's own parent.
    for (const elsewhere of [decoy, join(b.fyHome, 'state/claude-code/history-pool')]) {
      await mkdir(decoy, { recursive: true });
      await rm(join(b.homeOf('dst'), 'projects'), { force: true });
      await symlink(elsewhere, join(b.homeOf('dst'), 'projects'));
      const done = await b.harness.unpackConversation!(target, packed.value);
      expect(done.ok).toBe(false);
      if (!done.ok) expect(done.error.reason).toContain('shared history');
      expect(await poolFiles(b)).toEqual([]);
      expect(await readdir(decoy)).toEqual([]);
      expect(await readlink(join(b.homeOf('dst'), 'projects'))).toBe(elsewhere);
    }
  });

  test('a decoy `projects` link refuses BEFORE anything is moved: the home keeps its own history and the pool is untouched', async () => {
    const a = await machine('a');
    const b = await machine('b');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const target = spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID);
    await b.harness.prepareHome(target);
    const decoy = join(fixture, 'decoy');
    await mkdir(decoy, { recursive: true });
    const home = b.homeOf('dst');
    await rm(join(home, 'projects'), { force: true });
    await symlink(decoy, join(home, 'projects'));
    // The home's own (local, not yet pooled) history: a link-the-pool step would move it into the pool.
    await rm(join(home, 'history.jsonl'), { force: true, recursive: true });
    await writeFile(join(home, 'history.jsonl'), 'local-history\n');
    const poolBefore = await readdir(b.pool('.'), { recursive: true });
    const done = await b.harness.unpackConversation!(target, packed.value);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.reason).toContain('shared history');
    expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toBe('local-history\n');
    expect((await lstat(join(home, 'history.jsonl'))).isSymbolicLink()).toBe(false);
    expect(await readdir(b.pool('.'), { recursive: true })).toEqual(poolBefore);
    expect(await readdir(decoy)).toEqual([]);
    expect(await readlink(join(home, 'projects'))).toBe(decoy);
  });

  test('the link the launch made is accepted', async () => {
    const a = await machine('a');
    const b = await machine('b');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const target = spec(b, 'dst', join(fixture, 'b/wt'), NEW_ID);
    await b.harness.prepareHome(target);
    expect((await b.harness.unpackConversation!(target, packed.value)).ok).toBe(true);
  });
});

describe('a conversation moved with the installed Claude Code', () => {
  test('a 328-character folder is spelled the way Claude spells it (hashed), and the real claude resumes it there', async () => {
    const a = await machine('a');
    const b = await machine('b');
    await seedSource(a);
    const packed = await a.harness.packConversation!('src' as FerretId);
    if (!packed.ok) throw new Error(packed.error.reason);
    const longFolder = join(fixture, 'b/worktrees', 'd0'.padEnd(100, 'x'), 'd1'.padEnd(100, 'x'), 'd2'.padEnd(60, 'x'));
    expect(longFolder.length).toBeGreaterThan(300);
    await mkdir(longFolder, { recursive: true });
    const target = spec(b, 'dst', longFolder, NEW_ID);
    await b.harness.prepareHome(target);
    const done = await b.harness.unpackConversation!(target, packed.value);
    if (!done.ok) throw new Error(done.error.reason);
    const spelling = claudeProjectFolder(longFolder);
    expect(spelling).toHaveLength(207);
    expect(await poolFiles(b)).toEqual([`${spelling}/${NEW_ID}.jsonl`]);

    const server = stub();
    try {
      const resumed = await runClaude({
        args: ['-p', 'and now?', '--resume', NEW_ID],
        cwd: longFolder,
        config: b.homeOf('dst'),
        home: join(fixture, 'b/home'),
        url: server.url,
      });
      expect(resumed.err).toBe('');
      expect(resumed.code).toBe(0);
      const sent = server.bodies.find(body => body.includes('and now?'));
      for (const carried of ['question 1', 'answer 3']) expect(sent).toContain(carried);
    } finally {
      server.stop();
    }
  }, 120_000);

  test('a conversation the real `claude --worktree` wrote leaves no path of the source checkout, and the real claude resumes it', async () => {
    const a = await machine('a');
    const b = await machine('b');
    const source = join(fixture, 'a-src');
    const repo = join(source, 'repo');
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
        cwd: repo,
        env: { PATH: Bun.env.PATH ?? '', HOME: join(source, 'home'), GIT_CONFIG_NOSYSTEM: '1' },
      });
    await writeFile(join(repo, 'notes.txt'), 'a file\n');
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '.'],
      ['commit', '-qm', 'start'],
    ])
      git(...args);

    const server = stub();
    let transcript: string;
    const worktree = join(repo, '.claude/worktrees/wt1');
    try {
      // Machine A's ferret runs the REAL `claude --worktree`: its home is the one a launch prepares, so the conversation
      // lands in A's pool exactly where a started ferret's does.
      await a.harness.prepareHome(spec(a, 'src', repo));
      const wrote = await runClaude({
        args: ['--worktree', 'wt1', '-p', 'first question about the worktree'],
        cwd: repo,
        config: a.homeOf('src'),
        home: join(source, 'home'),
        url: server.url,
      });
      expect(wrote.code).toBe(0);
      const written = (await poolFiles(a)).filter(name => name.startsWith(`${spelled(worktree)}/`));
      expect(written).toHaveLength(1);
      const id = (written[0] ?? '').split('/')[1]?.replace(/\.jsonl$/u, '') ?? '';
      await writeFile(join(a.homeOf('src'), 'conversation.json'), JSON.stringify({ format: 1, id, cwd: worktree }));
      transcript = await readFile(a.pool(`projects/${written[0]}`), 'utf8');
      // The fixture is a REAL worktree transcript: the checkout it entered from is not the folder it worked in.
      const state = transcript
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, any>)
        .find(record => record.type === 'worktree-state');
      expect(state?.worktreeSession.originalCwd).toBe(repo);
      expect(state?.worktreeSession.preEnterOriginalCwd).toBe(repo);
      expect(state?.worktreeSession.worktreePath).toBe(worktree);
      expect(transcript).toContain(repo);

      const packed = await a.harness.packConversation!('src' as FerretId);
      if (!packed.ok) throw new Error(packed.error.reason);
      // Machine B holds the project as a git checkout with a worktree of it (the folder the ferret works in), as a moved
      // ferret's folder is: Claude Code refuses to resume a worktree conversation from a folder that is no git worktree.
      const bRepo = join(fixture, 'b/checkout');
      const bFolder = join(fixture, 'b/worktrees/app-wt');
      await mkdir(bRepo, { recursive: true });
      const gitB = (...args: string[]) =>
        Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
          cwd: bRepo,
          env: { PATH: Bun.env.PATH ?? '', HOME: join(fixture, 'b/home'), GIT_CONFIG_NOSYSTEM: '1' },
        });
      await writeFile(join(bRepo, 'notes.txt'), 'a file\n');
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['add', '.'],
        ['commit', '-qm', 'start'],
        ['worktree', 'add', '-q', bFolder],
      ])
        gitB(...args);
      const target = spec(b, 'dst', bFolder, NEW_ID);
      await b.harness.prepareHome(target);
      const done = await b.harness.unpackConversation!(target, packed.value);
      if (!done.ok) throw new Error(done.error.reason);

      // Every file B holds for it: no folder of the source checkout, as a path or as Claude's dashed spelling of one, no
      // old id, and none of machine A's own folders either.
      const unpacked = await readFile(b.pool(`projects/${spelled(bFolder)}/${NEW_ID}.jsonl`), 'utf8');
      for (const gone of [source, spelled(source), id, a.fyHome]) expect(unpacked).not.toContain(gone);
      const records = unpacked
        .split('\n')
        .filter(line => line.startsWith('{'))
        .map(line => JSON.parse(line) as Record<string, any>);
      // The binding to the source checkout is not carried: Claude refuses to resume into a worktree that is the checkout it
      // launched from, and the checkout this conversation was entered from is not on B.
      expect(records.some(record => record.type === 'worktree-state')).toBe(false);
      for (const record of records) if (typeof record.cwd === 'string') expect(record.cwd).toBe(bFolder);

      // And the real Claude Code carries the conversation on in the new folder.
      const resumed = await runClaude({
        args: ['-p', 'and now?', '--resume', NEW_ID],
        cwd: bFolder,
        config: b.homeOf('dst'),
        home: join(fixture, 'b/home'),
        url: server.url,
      });
      expect(resumed.err).toBe('');
      expect(resumed.code).toBe(0);
      const sent = server.bodies.find(body => body.includes('and now?'));
      expect(sent).toContain('first question about the worktree');
      expect(sent).not.toContain(source);
    } finally {
      server.stop();
    }
  }, 180_000);
});
