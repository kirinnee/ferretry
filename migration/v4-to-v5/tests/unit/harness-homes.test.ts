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
  const copied = join(f.to, 'state/codex/agent-homes/_shared/sessions/rollout.jsonl');
  expect(await readFile(copied)).toEqual(bytes);
  const metadata = await stat(copied);
  expect(metadata.mode & 0o777).toBe(0o640);
  expect(metadata.mtimeMs).toBe(time.getTime());
  expect(await readFile(join(f.to, 'state/codex/agent-homes', RUNTIME, '.claude.json'), 'utf8')).toContain(
    'FAKE-PRIVATE-STATE',
  );
  expect(await stat(join(f.to, 'state/codex/agent-homes/_shared/sqlite/state.db'))).toBeDefined();
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
  expect(
    await stat(join(f.to, 'state/claude-code/agent-homes/_shared/projects/project/conversation.jsonl')),
  ).toBeDefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
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
  expect(
    await stat(join(f.to, 'state/claude-code/agent-homes/_shared/.leases')).catch(() => undefined),
  ).toBeUndefined();
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
