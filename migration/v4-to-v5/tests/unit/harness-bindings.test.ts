import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FerretId } from '@ferretry/kernel/contract';
import {
  CLAUDE_CODE_AGENT_HOMES,
  CLAUDE_CODE_HISTORY_ENTRIES,
  CLAUDE_CODE_HISTORY_POOL,
} from '@ferretry/plugin-claude-code/contract';
import {
  CODEX_AGENT_HOMES,
  CODEX_HISTORY_ENTRIES,
  CODEX_HISTORY_POOL,
  CODEX_ROLLOUTS,
  CodexRolloutBindingSchema,
} from '@ferretry/plugin-codex/contract';
import { CodexRollouts } from '../../../../packages/plugins/codex/daemon/adapters/rollouts.ts';
import { createNodeHostFs, createStatePort } from '../../../../packages/core/kernel/host/state/index.ts';
import { ClaudeHarness } from '../../../../packages/plugins/claude-code/daemon/adapters/claude-harness.ts';
import { PaneDirectory } from '../../../../packages/plugins/claude-code/daemon/adapters/tmux-pane.ts';
import { nodeFs } from '../../../../packages/core/kernel/host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../packages/core/kernel/host/roots.ts';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const CONVERSATION = '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21';
const CWD = '/work/project';
const SLUG = '-work-project';
const POOL_PERMISSION = { state: CLAUDE_CODE_HISTORY_POOL.name, entries: CLAUDE_CODE_HISTORY_ENTRIES };
const AT = '2026-11-01T10:00:00.000Z';

const transcript = (more: Record<string, unknown> = {}) => ({
  v: 1,
  identity: 'adopted',
  home: '/old/home',
  harnessSessionId: CONVERSATION,
  file: '/old/home/projects/x/y.jsonl',
  resolvedAt: AT,
  ...more,
});

/** The real Claude reader over the CONVERTED home, as the daemon builds it: no launch, no resume, no prepareHome. */
async function claudeReader() {
  for (const folder of ['', 'state', 'state/claude-code', 'state/claude-code/agent-homes'])
    await chmod(join(f.to, folder), 0o700);
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home: f.to, plugin: 'claude-code' }, ['agent-homes', 'harness-history'], {
    historyPool: POOL_PERMISSION,
    stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL],
  });
  const roots = rootsPortFor(
    fs,
    { home: f.to, plugin: 'claude-code', worktrees: join(f.root, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { historyPool: POOL_PERMISSION, stateFiles: [CLAUDE_CODE_AGENT_HOMES, CLAUDE_CODE_HISTORY_POOL] },
  );
  return new ClaudeHarness({
    selected: async () => ({ settings: { has: () => true }, hooks: { has: () => true } }) as never,
    roots,
    config: { file: () => ({ searchPaths: [], permissionMode: 'auto' }), collection: () => new Map() } as never,
    // Reading a transcript never touches the launch-settings record.
    state: {} as never,
    spawn: { run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }) } as never,
    clock: { sleep: async () => {}, after: () => () => {} } as never,
    redaction: { read: async (fn: (scope: unknown) => unknown) => await fn({ text: (s: string) => s }) } as never,
    location: {} as never,
    probe: {} as never,
    update: {} as never,
    panes: new PaneDirectory(),
    permission: {} as never,
    dialog: {} as never,
    newConversationId: () => CONVERSATION,
    historyHome: async () => join(f.root, 'owner/.claude'),
  });
}

const userLine = `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: AT, message: { role: 'user', content: 'hello v4' } })}\n`;

test('E7 a converted stopped Claude ferret reads its v4 transcript with no resume', async () => {
  await f.session('f1', { harness: 'claude', agent: 'claude-work', cwd: CWD, transcript: transcript() });
  // A real transcript line, not the JSON the fixture writes for opaque files.
  await mkdir(join(f.from, `fleet/shared/claude/projects/${SLUG}`), { recursive: true });
  await writeFile(join(f.from, `fleet/shared/claude/projects/${SLUG}/${CONVERSATION}.jsonl`), userLine);
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(item => item.what.startsWith('converted ferret homes bound'))?.count).toBe(1);

  const home = join(f.to, 'state/claude-code/agent-homes/f1');
  expect(JSON.parse(await readFile(join(home, 'conversation.json'), 'utf8'))).toEqual({
    format: 1,
    id: CONVERSATION,
    cwd: CWD,
  });
  expect((await stat(join(home, 'conversation.json'))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(home, 'projects'))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(home, 'projects'))).toBe(join(f.to, 'state/claude-code/history-pool/projects'));

  const harness = await claudeReader();
  const entries = await harness.transcript.read('f1' as FerretId);
  expect(entries.map(entry => entry.id)).toEqual(['u1']);
});

test('E7 a Claude ferret with no harnessSessionId gets no binding and no link', async () => {
  await f.session('f1', { harness: 'claude', agent: 'claude-work', cwd: CWD });
  await f.session('f2', {
    harness: 'claude',
    agent: 'claude-work',
    cwd: CWD,
    transcript: { v: 1, identity: 'undiscovered', home: '/old/home', resolvedAt: AT },
  });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(item => item.what.startsWith('converted ferret homes bound'))?.count).toBe(0);
  for (const id of ['f1', 'f2'])
    expect(await lstat(join(f.to, 'state/claude-code/agent-homes', id)).catch(() => undefined)).toBeUndefined();
});

test('E7 a Claude conversation id or folder the v5 reader would refuse is not bound', async () => {
  await f.session('f1', {
    harness: 'claude',
    agent: 'claude-work',
    cwd: CWD,
    transcript: transcript({ harnessSessionId: '../escape' }),
  });
  await f.session('f2', { harness: 'claude', agent: 'claude-work', cwd: 'relative/dir', transcript: transcript() });
  expect((await harnessHomesStep.run(f.ctx())).status).toBe('converted');
  for (const id of ['f1', 'f2'])
    expect(await lstat(join(f.to, 'state/claude-code/agent-homes', id)).catch(() => undefined)).toBeUndefined();
});

test('E7 a dry run binds nothing and a preview never carries the conversation id, so binds nothing', async () => {
  await f.session('f1', { harness: 'claude', agent: 'claude-work', cwd: CWD, transcript: transcript() });
  const dry = await harnessHomesStep.run(f.ctx(true));
  expect(dry.kept.find(item => item.what.startsWith('converted ferret homes bound'))?.count).toBe(1);
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
  const preview = await harnessHomesStep.run({ ...f.ctx(), preview: true });
  expect(preview.kept.find(item => item.what.startsWith('converted ferret homes bound'))?.count).toBe(0);
  expect(await lstat(join(f.to, 'state/claude-code/agent-homes/f1')).catch(() => undefined)).toBeUndefined();
});

test('E7 a converted Codex ferret gets the rollout record its reader proves from and the sessions link', async () => {
  await f.session('f1', {
    transcript: { ...transcript(), identity: 'correlated', harnessSessionId: 'conversation1' },
  });
  await f.put('fleet/shared/codex/sessions/2026/11/01/rollout-2026-11-01T10-00-00-conversation1.jsonl', {});
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const home = join(f.to, 'state/codex/agent-homes/f1');
  const record = JSON.parse(await readFile(join(f.to, 'state/codex', CODEX_ROLLOUTS.path.replace('*', 'f1')), 'utf8'));
  expect(CodexRolloutBindingSchema.parse(record)).toEqual({ format: 1, home, baseline: [], native: 'conversation1' });
  expect(record.format).toBe(1);
  expect(await readlink(join(home, 'sessions'))).toBe(join(f.to, 'state/codex/history-pool/sessions'));
  expect(await stat(join(f.to, 'state/codex/history-pool/sessions/2026/11/01')).then(s => s.isDirectory())).toBe(true);
});

test("E7 the real Codex reader reads a converted stopped Codex ferret's rollout with no resume", async () => {
  await f.session('f1', {
    transcript: { ...transcript(), identity: 'correlated', harnessSessionId: 'conversation1' },
  });
  const rollout = [
    JSON.stringify({ timestamp: AT, type: 'session_meta', payload: { id: 'conversation1', cwd: CWD } }),
    JSON.stringify({
      timestamp: AT,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello v4' }] },
    }),
    '',
  ].join('\n');
  const name = 'sessions/2026/11/01/rollout-2026-11-01T10-00-00-conversation1.jsonl';
  await mkdir(join(f.from, 'fleet/shared/codex/sessions/2026/11/01'), { recursive: true });
  await writeFile(join(f.from, 'fleet/shared', 'codex', name), rollout);
  expect((await harnessHomesStep.run(f.ctx())).status).toBe('converted');

  for (const folder of ['', 'state', 'state/codex', 'state/codex/agent-homes']) await chmod(join(f.to, folder), 0o700);
  const options = {
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
    stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
  };
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home: f.to, plugin: 'codex' },
    ['agent-homes', 'harness-history'],
    options,
  );
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: f.to, plugin: 'codex', worktrees: join(f.root, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...options },
  );
  const kernel = {
    roots,
    state: createStatePort({ home: f.to, pluginId: 'codex', files: [CODEX_ROLLOUTS], fs: createNodeHostFs() }),
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: { after: () => () => undefined, now: () => AT, sleep: async () => undefined },
  };
  const rollouts = new CodexRollouts(kernel as never, async () => undefined);
  const read = await rollouts.transcript.read('f1' as FerretId);
  expect(JSON.stringify(read)).toContain('hello v4');
});
