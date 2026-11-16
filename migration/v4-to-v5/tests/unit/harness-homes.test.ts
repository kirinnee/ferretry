import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';
import { fixture, RUNTIME } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

test('copies opaque transcripts, sqlite and user state byte for byte with modes and times', async () => {
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [{ id: RUNTIME, kind: 'codex', home: join(f.from, 'fleet/homes', RUNTIME) }],
  });
  await f.put(`fleet/homes/${RUNTIME}/.claude.json`, { fakeUserState: 'FAKE-PRIVATE-STATE' });
  await f.put('fleet/shared/codex/sqlite/state.db', 'FAKE-SQLITE');
  const transcript = join(f.from, 'fleet/shared/codex/sessions/rollout.jsonl');
  await mkdir(join(transcript, '..'), { recursive: true });
  const bytes = Buffer.from([0, 255, 10, 123, 0, 1]);
  await writeFile(transcript, bytes);
  await chmod(transcript, 0o640);
  const time = new Date('2026-10-01T00:00:00.000Z');
  await utimes(transcript, time, time);
  await symlink(
    join(f.from, 'fleet/credentials/never-open/auth.json'),
    join(f.from, 'fleet/homes', RUNTIME, 'auth.json'),
  );
  await symlink(join(f.from, 'fleet/shared/codex/sessions'), join(f.from, 'fleet/homes', RUNTIME, 'sessions'));
  await f.put('fleet/credentials/never-open/auth.json', { secret: 'FAKE-SECRET-SIGNIN' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const copied = join(f.to, 'state/codex/history-pool/sessions/rollout.jsonl');
  expect(await readFile(copied)).toEqual(bytes);
  const metadata = await stat(copied);
  expect(metadata.mode & 0o777).toBe(0o640);
  expect(metadata.mtimeMs).toBe(time.getTime());
  expect(await readFile(join(f.to, 'state/codex/agent-homes', RUNTIME, '.claude.json'), 'utf8')).toContain(
    'FAKE-PRIVATE-STATE',
  );
  expect(await stat(join(f.to, 'state/codex/history-pool/sqlite/state.db'))).toBeDefined();
  expect(
    await stat(join(f.to, 'state/codex/agent-homes', RUNTIME, 'auth.json')).catch(() => undefined),
  ).toBeUndefined();
  expect(await stat(join(f.to, 'state/codex/agent-homes', RUNTIME, 'sessions')).catch(() => undefined)).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
  expect(report.notCarried.some(item => item.what.includes('symlinks'))).toBe(true);
});

test('maps a former runtime name and copies the Claude pool without parsing it', async () => {
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'claude-current': { id: RUNTIME, formerNames: ['claude-old'] } },
  });
  await f.session('f1', { harness: 'claude', agent: 'claude-old' });
  await f.put(`fleet/homes/${RUNTIME}/.claude.json`, { user: 'FAKE-STATE' });
  await f.put('fleet/shared/claude/projects/project/conversation.jsonl', 'FAKE-NOT-A-TRANSCRIPT');
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await stat(join(f.to, 'state/claude-code/agent-homes', RUNTIME, '.claude.json'))).toBeDefined();
  expect(await stat(join(f.to, 'state/claude-code/history-pool/projects/project/conversation.jsonl'))).toBeDefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('reads the published v4 runtimes harness field and derives its home from ids', async () => {
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [],
    runtimes: [{ id: RUNTIME, name: 'codex-work', harness: 'codex' }],
  });
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'codex-work': { id: RUNTIME, formerNames: [], home: 'custom-home' } },
  });
  await f.put('fleet/homes/custom-home/user-state', 'FAKE-STATE');
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await stat(join(f.to, 'state/codex/agent-homes', RUNTIME, 'user-state'))).toBeDefined();
});

test('missing folders carry zero and dry run does not copy files', async () => {
  expect((await harnessHomesStep.run(f.ctx())).kept.every(item => item.count === 0)).toBe(true);
  await f.put('fleet/shared/claude/history.jsonl', 'FAKE-HISTORY');
  const report = await harnessHomesStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.sealed).toHaveLength(1);
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('unmapped runtime folders are explicit gaps and transient files are omitted', async () => {
  await f.put(`fleet/homes/${RUNTIME}/user-state`, 'FAKE-STATE');
  await f.put('fleet/shared/claude/.leases/conversation', { holder: 'FAKE-LEASE' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(item => item.what.startsWith('homes omitted'))?.count).toBe(1);
  expect(await stat(join(f.to, 'state/claude-code/history-pool/.leases')).catch(() => undefined)).toBeUndefined();
});

test('writes each harness pool to its one history pool, beside agent-homes and never inside it', async () => {
  const slug = '-home-owner-project';
  const id = '33333333-3333-4333-8333-333333333333';
  await f.put(`fleet/shared/claude/projects/${slug}/${id}.jsonl`, 'FAKE-CLAUDE-TRANSCRIPT');
  await f.put('fleet/shared/claude/history.jsonl', 'FAKE-CLAUDE-HISTORY');
  await f.put('fleet/shared/claude/.leases/conversation', { holder: 'FAKE-LEASE' });
  await f.put('fleet/shared/codex/sessions/2026/11/01/rollout-fake.jsonl', 'FAKE-ROLLOUT');
  await f.put('fleet/shared/codex/sqlite/state.db', 'FAKE-SQLITE');
  await f.put('fleet/shared/codex/.leases/conversation', { holder: 'FAKE-LEASE' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const claudePool = join(f.to, 'state/claude-code/history-pool');
  const codexPool = join(f.to, 'state/codex/history-pool');
  expect(await readFile(join(claudePool, 'projects', slug, `${id}.jsonl`), 'utf8')).toContain('FAKE-CLAUDE-TRANSCRIPT');
  expect(await readFile(join(claudePool, 'history.jsonl'), 'utf8')).toContain('FAKE-CLAUDE-HISTORY');
  expect(await readFile(join(codexPool, 'sessions/2026/11/01/rollout-fake.jsonl'), 'utf8')).toContain('FAKE-ROLLOUT');
  expect(await readFile(join(codexPool, 'sqlite/state.db'), 'utf8')).toContain('FAKE-SQLITE');
  // v4's lease store is not history: it is never written to the pool.
  expect(await stat(join(claudePool, '.leases')).catch(() => undefined)).toBeUndefined();
  expect(await stat(join(codexPool, '.leases')).catch(() => undefined)).toBeUndefined();
  // Nothing is written as agent-homes/_shared any more.
  for (const harness of ['claude-code', 'codex'])
    expect(await stat(join(f.to, 'state', harness, 'agent-homes/_shared')).catch(() => undefined)).toBeUndefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('malformed metadata fails without exposing values', async () => {
  await f.put('fleet/ids.json', { version: 'FAKE-SECRET' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-SECRET');
});

test('never follows a linked pool or credential link', async () => {
  await mkdir(join(f.from, 'fleet/shared'), { recursive: true });
  await symlink('/unreadable/fake-credential', join(f.from, 'fleet/shared/codex'));
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.sealed).toHaveLength(0);
  expect(report.kept.find(item => item.what.startsWith('links omitted'))?.count).toBe(1);
});

test('a linked runtime home is recorded as a gap without reading its target', async () => {
  await mkdir(join(f.from, 'fleet/homes'), { recursive: true });
  await symlink('/unreadable/fake-credential', join(f.from, 'fleet/homes', RUNTIME));
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.sealed).toHaveLength(0);
  expect(report.kept.find(item => item.what.startsWith('links omitted'))?.count).toBe(1);
});

// The v4 files record ABSOLUTE paths of the place they were written. The home is moved aside before it is converted
// (and may be copied), so those paths point at a folder that is no longer where the home is.
const OLD_HOME = '/somewhere/else/entirely/home';

test('a runtime home recorded at the home the v4 files were written in (now moved) still converts', async () => {
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [{ id: RUNTIME, kind: 'claude', home: `${OLD_HOME}/fleet/homes/${RUNTIME}` }],
    runtimes: [{ id: RUNTIME, name: 'claude-work', harness: 'claude' }],
  });
  await f.put('fleet/ids.json', { version: 1, runtimes: { 'claude-work': { id: RUNTIME, formerNames: [] } } });
  await f.session('f1', {
    harness: 'claude',
    agent: 'claude-work',
    transcript: {
      v: 1,
      home: `${OLD_HOME}/fleet/homes/${RUNTIME}`,
      harnessSessionId: '22222222-2222-4222-8222-222222222222',
      identity: 'minted',
      file: `${OLD_HOME}/fleet/homes/${RUNTIME}/projects/p/22222222-2222-4222-8222-222222222222.jsonl`,
      resolvedAt: '2026-11-01T00:00:00.000Z',
    },
  });
  await f.put(`fleet/homes/${RUNTIME}/.claude.json`, { user: 'FAKE-STATE' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(item => item.what.startsWith('runtime homes'))?.count).toBe(1);
  expect(await stat(join(f.to, 'state/claude-code/agent-homes', RUNTIME, '.claude.json'))).toBeDefined();
});

test('a home recorded outside any fleet/homes folder is still left out, not converted', async () => {
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [{ id: RUNTIME, kind: 'claude', home: `/external/user-home/${RUNTIME}` }],
  });
  await f.put(`fleet/homes/${RUNTIME}/.claude.json`, { user: 'FAKE-STATE' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept.find(item => item.what.startsWith('homes omitted'))?.count).toBe(1);
});

test('two records that disagree about a runtime fail naming both files and the runtime, never a value', async () => {
  await f.put('fleet/manifest.json', {
    version: 1,
    accounts: [{ id: RUNTIME, kind: 'claude', home: join(f.from, 'fleet/homes', RUNTIME) }],
    runtimes: [{ id: RUNTIME, name: 'codex-work', harness: 'codex' }],
  });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('fleet/manifest.json');
  expect(report.note).toContain(RUNTIME);
  expect(report.note).not.toContain(f.from);
});

test('a malformed document is named by its path inside the home', async () => {
  await f.put('fleet/ids.json', { version: 'FAKE-SECRET' });
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('fleet/ids.json');
  expect(report.note).not.toContain('FAKE-SECRET');
});

test('a device file in a pool is refused by name (relative to the home) and stays refused', async () => {
  await f.put('fleet/shared/claude/history.jsonl', 'FAKE-HISTORY');
  const fifo = join(f.from, 'fleet/shared/claude/projects/pipe');
  await mkdir(join(fifo, '..'), { recursive: true });
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
  const report = await harnessHomesStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('fleet/shared/claude/projects/pipe');
  expect(report.note).toContain('not a regular file');
  expect(report.note).not.toContain(f.from);
  expect(report.sealed).toHaveLength(0);
});
