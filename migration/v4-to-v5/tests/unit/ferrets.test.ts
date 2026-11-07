import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FerretRecordSchema, FerretTokensSchema } from '@ferretry/core-ferrets/contract';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { harnessHomesStep } from '../../src/steps/harness-homes.ts';
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
  await f.put('state/sessions/lead/state.json', { id: 'lead', status: 'thinking', turn: 0, lastActivityAt: AT });
  await f.pane('lead');
  const provenance = {
    v: 1,
    at: AT,
    origin: 'session',
    parent: 'lead',
    wardenLineage: false,
    lineageSource: 'none',
  } as const;
  const transferredFrom = {
    v: 1,
    kind: 'fork',
    sourceSessionId: 'older',
    sourceIncarnation: 'i1',
    sourceHarness: 'claude',
    cutMessagePoint: { v: 1, byteOffset: 0, blockIndex: 0 },
    planId: 'plan1',
    at: AT,
  } as const;
  await f.session('child', { parent: 'lead', provenance, transferredFrom, projectId: RUNTIME });
  await f.put('state/sessions/child/state.json', { id: 'child', status: 'completed', turn: 0, finishedAt: AT });
  await f.put('state/archived-sessions.json', {
    version: 1,
    sessions: { child: { archivedAt: AT, lastSequence: 0, journalLine: 1, journal: null } },
  });
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
  expect(child.provenance).toEqual(provenance);
  expect(child.transferredFrom).toEqual(transferredFrom);
  expect(child.projectId).toBe(RUNTIME);
  const lead = await record('lead');
  expect(lead.transcript?.home).toBe(join(f.to, 'state/claude-code/agent-homes', RUNTIME));
  expect(lead.transcript?.file).toBe(
    join(f.to, 'state/claude-code/agent-homes/_shared/projects/project/resume1.jsonl'),
  );
  const tokens = FerretTokensSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets/tokens.json'), 'utf8')));
  expect(tokens.tokens).toHaveLength(1);
  expect(String(tokens.tokens[0]?.ferret)).toBe('lead');
  expect(tokens.tokens[0]?.digest).toBe(FAKE_HASH);
  expect(tokens.tokens[0]?.issuedAt).toBe(AT);
  expect((await stat(join(f.to, 'state/ferrets/lead/ferret.json'))).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.to, 'state/ferrets/lead'))).mode & 0o777).toBe(0o700);
  for (const path of ['history.jsonl', 'names.json', 'worktrees.json', 'forks'])
    expect(await stat(join(f.to, 'state/ferrets', path)).catch(() => undefined)).toBeUndefined();
  expect(report.notCarried.map(item => item.what).join(' ')).not.toContain('formerNames');
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

test('a ferret a person cut off stays cut off, even though v4 dropped its hash', async () => {
  // v4's cut-off drops the hash and sets credentialRevoked; v5 needs a cutOff row or it would relaunch the ferret.
  await f.session('cut', { credentialRevoked: true });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  const tokens = FerretTokensSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets/tokens.json'), 'utf8')));
  const row = tokens.tokens.find(token => token.ferret === 'cut');
  expect(row?.cutOff).toBe(true);
  expect(row?.revoked).toBe(true);
  expect(row?.digest).toBe('0'.repeat(64));
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

test('rewrites Codex home and pooled rollout paths to files the opaque copy creates', async () => {
  const home = join(f.from, 'fleet/homes/custom-home');
  const transcript = {
    v: 1,
    identity: 'correlated',
    home,
    file: join(home, 'sessions/year/rollout.jsonl'),
    harnessSessionId: 'conversation1',
    baseline: ['existing-conversation'],
    correlationToken: 'FAKE-CORRELATION',
    resolvedAt: AT,
  };
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'codex-work': { id: RUNTIME, formerNames: [], home: 'custom-home' } },
  });
  await f.session('f1', { transcript });
  await f.put('fleet/homes/custom-home/user-state', 'FAKE-USER-STATE');
  await f.put('fleet/shared/codex/sessions/year/rollout.jsonl', 'FAKE-OPAQUE-ROLLOUT');
  await symlink(join(f.from, 'fleet/shared/codex/sessions'), join(home, 'sessions'));
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await harnessHomesStep.run(f.ctx())).status).toBe('converted');
  const rewritten = (await record('f1')).transcript;
  expect(rewritten?.home).toBe(join(f.to, 'state/codex/agent-homes', RUNTIME));
  expect(rewritten?.file).toBe(join(f.to, 'state/codex/agent-homes/_shared/sessions/year/rollout.jsonl'));
  expect(rewritten?.baseline).toEqual(['existing-conversation']);
  expect(rewritten?.correlationToken).toBe('FAKE-CORRELATION');
  expect(await stat(rewritten!.home)).toBeDefined();
  expect(await stat(rewritten!.file!)).toBeDefined();
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('does not rewrite a transcript outside the owned home prefix but keeps its resume id', async () => {
  await f.session('f1', {
    transcript: {
      v: 1,
      identity: 'adopted',
      home: join(f.from, 'fleet/homes-elsewhere', RUNTIME),
      file: '/external/file.jsonl',
      harnessSessionId: 'resume1',
    },
  });
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await record('f1')).harnessConversation).toBe('resume1');
  expect((await record('f1')).transcript).toBeUndefined();
  expect(report.notCarried.some(item => item.what.includes('transcript pointers outside'))).toBe(true);
});

test('a damaged warden provenance stamp fails rather than dropping the lineage fact', async () => {
  await f.session('f1', {
    provenance: { v: 1, at: AT, origin: 'warden', warden: 'FAKE-WARDEN', wardenLineage: false, lineageSource: 'none' },
  });
  const report = await ferretsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(JSON.stringify(report)).not.toContain('FAKE-');
});

test('missing session files carry zero and dry run writes nothing', async () => {
  expect((await ferretsStep.run(f.ctx())).kept.every(item => item.count === 0)).toBe(true);
  await f.session();
  expect((await ferretsStep.run(f.ctx(true))).status).toBe('converted');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('bad JSON, invalid v5 values and identity mismatches fail without exposing values', async () => {
  for (const extra of [
    { createdAt: 'SECRET-FAKE-NOT-AN-INSTANT' },
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

test('the v5 name is the v4 callsign; the title is the fallback, then the id', async () => {
  await f.session('called', { name: 'Fake Task Title', teammate: 'fakecall' });
  await f.session('titled', { name: 'Fake Old Title' });
  await f.session('odd', { name: 'Fake: title with a colon' });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect(String((await record('called')).name)).toBe('fakecall');
  expect(String((await record('titled')).name)).toBe('Fake Old Title');
  expect(String((await record('odd')).name)).toBe('odd');
});
