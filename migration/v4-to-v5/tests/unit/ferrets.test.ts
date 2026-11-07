import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FerretRecordSchema, FerretTokensSchema } from '@ferretry/core-ferrets/contract';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { AT, FAKE_HASH, fixture, RUNTIME } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});
const record = async (id: string) =>
  FerretRecordSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets', id, 'ferret.json'), 'utf8')));

test('keeps live and archived ids, parent, runtime, resume id and D15 pane handle', async () => {
  await f.session('lead', {
    harness: 'claude',
    agent: '/old/fleet/bin/claude-work',
    transcript: {
      v: 1,
      identity: 'minted',
      home: join(f.from, 'fleet/homes', RUNTIME),
      file: join(f.from, 'fleet/shared/claude/projects/project/resume1.jsonl'),
      harnessSessionId: 'resume1',
    },
    sessionCapabilityHash: FAKE_HASH,
  });
  await f.put('state/sessions/lead/state.json', { id: 'lead', status: 'thinking', lastActivityAt: AT });
  await f.pane('lead');
  await f.session('child', {
    parent: 'lead',
    provenance: { origin: 'session' },
    transferredFrom: { source: 'older' },
    projectId: 'p1',
  });
  await f.put('state/sessions/child/state.json', { id: 'child', status: 'completed', finishedAt: AT });
  await f.put('state/archived-sessions.json', { version: 1, sessions: [{ id: 'child' }] });
  // A broken credential link must never be followed or opened.
  await symlink('/unreadable/fake-credential', join(f.from, 'state/sessions/lead/environment.json'));
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await record('lead')).toMatchObject({
    id: 'lead',
    role: 'lead',
    runtime: 'claude-work',
    harness: 'claude-code',
    harnessConversation: 'resume1',
    folder: '/work/project',
    state: 'working',
    handle: '%12',
  });
  const child = await record('child');
  expect(String(child.id)).toBe('child');
  expect(String(child.parent)).toBe('lead');
  expect(child.role).toBe('helper');
  expect(child.state).toBe('stopped');
  const tokens = FerretTokensSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets/tokens.json'), 'utf8')));
  expect(tokens.tokens).toHaveLength(1);
  expect(String(tokens.tokens[0]?.ferret)).toBe('lead');
  expect(tokens.tokens[0]?.digest).toBe(FAKE_HASH);
  expect(tokens.tokens[0]?.issuedAt).toBe(AT);
  expect((await stat(join(f.to, 'state/ferrets/lead/ferret.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.to, 'state/ferrets/lead'))).mode & 0o777).toBe(0o700);
  for (const path of ['history.jsonl', 'names.json', 'archive.json', 'worktrees.json', 'forks'])
    expect(await stat(join(f.to, 'state/ferrets', path)).catch(() => undefined)).toBeUndefined();
  expect(report.notCarried.map(item => item.what).join(' ')).toContain('transcript.home');
  expect(report.notCarried.map(item => item.what).join(' ')).toContain('formerNames');
  expect(JSON.stringify(report)).not.toContain(FAKE_HASH);
});

test('keeps revoked token hashes revoked and leaves undiscovered conversations unset', async () => {
  await f.session('f1', {
    sessionCapabilityHash: FAKE_HASH,
    credentialRevoked: true,
    transcript: { v: 1, identity: 'undiscovered', home: '/old/home' },
  });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await record('f1')).harnessConversation).toBeUndefined();
  expect(JSON.parse(await readFile(join(f.to, 'state/ferrets/tokens.json'), 'utf8')).tokens[0].revoked).toBe(true);
});

test('resolves former runtime names to the current runtime name without writing a names document', async () => {
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'codex-current': { id: RUNTIME, formerNames: ['codex-work'] } },
  });
  await f.session();
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await record('f1')).runtime).toBe('codex-current');
  expect(await stat(join(f.to, 'state/ferrets/names.json')).catch(() => undefined)).toBeUndefined();
});

test('missing session files carry zero and dry run writes nothing', async () => {
  expect((await ferretsStep.run(f.ctx())).kept.every(item => item.count === 0)).toBe(true);
  await f.session();
  expect((await ferretsStep.run(f.ctx(true))).status).toBe('converted');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('bad JSON, invalid v5 values and identity mismatches fail without exposing values', async () => {
  for (const extra of [
    { name: 'SECRET-FAKE-INVALID!' },
    { id: 'wrong-id' },
    { sessionCapabilityHash: 'SECRET-FAKE-HASH' },
  ]) {
    await f.session('f1', extra);
    const report = await ferretsStep.run(f.ctx());
    expect(report.status).toBe('failed');
    expect(JSON.stringify(report)).not.toContain('SECRET-FAKE');
    expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
  }
  await writeFile(join(f.from, 'state/sessions/f1/config.json'), '{SECRET-FAKE-JSON');
  expect(JSON.stringify(await ferretsStep.run(f.ctx()))).not.toContain('SECRET-FAKE');
});

test('refuses a linked state directory without following it', async () => {
  await symlink('/unreadable/fake-credentials', join(f.from, 'state'));
  expect((await ferretsStep.run(f.ctx())).status).toBe('failed');
});
