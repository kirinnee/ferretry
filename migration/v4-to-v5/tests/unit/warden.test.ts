import { afterEach, beforeEach, expect, test } from 'bun:test';
import { JevChecksFileSchema, RememberedFileSchema, WardenStateFileSchema } from '@ferretry/plugin-warden/contract';
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  V5_WARDEN_JEV_CHECKS,
  V5_WARDEN_REMEMBERED,
  V5_WARDEN_REPORTS,
  V5_WARDEN_STATE,
  wardenStep,
} from '../../src/steps/warden.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const LATER = '2026-11-02T00:00:00.000Z';
/** A FAKE stand-in for the plaintext stop capability v4 keeps per assignment: it must reach no v5 file or report. */
const FAKE_CAPABILITY = 'FAKE-WARDEN-CAPABILITY-NOT-A-SECRET';
const REPORT = '2026-11-01T00-00-00-000Z-lead.md';

const read = async (path: string) => JSON.parse(await readFile(join(f.to, path), 'utf8')) as Record<string, unknown>;

async function everything(root: string): Promise<string> {
  const names = await readdir(root, { recursive: true });
  const texts = await Promise.all(
    names.map(async name => ((await stat(join(root, name))).isFile() ? readFile(join(root, name), 'utf8') : '')),
  );
  return texts.join('\n');
}

test('carries the sweep memory, moves blessings to remembered.json and drops the assignment capability', async () => {
  const reportPath = join(f.from, 'state/warden/reports', REPORT);
  await f.put('state/warden/state.json', {
    lastSweepAt: AT,
    failover: { strikes: { 'claude-work': { count: 2, lastAt: AT, lastReason: 'rate limited' } } },
    blessings: {
      lead: { sessionId: 'lead', kinds: ['sus_thinking'], status: 'thinking', blessedAt: AT, expiresAt: LATER },
      child: {
        sessionId: 'child',
        kinds: ['dead_monitor', 'input_stuck'],
        status: 'awaiting_user',
        blessedAt: AT,
        expiresAt: LATER,
        by: 'owner',
        streak: 2,
        untilChange: true,
        wardenId: 'warden-000001',
      },
      broken: { sessionId: 'broken', kinds: ['FAKE-KIND'], status: 'x', blessedAt: AT, expiresAt: LATER },
    },
    assignments: {
      lead: { wardenId: 'w1', spawnedAt: AT, capability: FAKE_CAPABILITY, kinds: ['sus_thinking'], reportPath },
    },
    investigations: [
      { id: 'i1', scope: 'session', origin: 'sweep', startedAt: AT, reportPath, targetId: 'lead' },
      { id: 'i2', scope: 'fleet', origin: 'sweep', startedAt: AT, reportPath: '/elsewhere/FAKE.md' },
    ],
    sweepCoverage: { wardenId: 'w2', reportPath, anomalies: [{ sessionId: 'lead', kind: 'sus_thinking' }] },
  });
  const report = await wardenStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'blessings', count: 2 });
  expect(report.note).toContain('1 damaged blessing(s) not carried');
  expect(report.note).toContain('1 report path(s) outside the reports folder dropped');

  const state = WardenStateFileSchema.parse(await read(V5_WARDEN_STATE));
  expect(Object.keys(state)[0]).toBe('format');
  expect(state).not.toHaveProperty('blessings');
  expect(state).not.toHaveProperty('assignments');
  expect(state.lastSweepAt).toBe(AT);
  expect(state.failover).toEqual({
    strikes: { 'claude-work': { count: 2, lastAt: AT, lastReason: 'rate limited' } },
  });
  const moved = f.ctx().v5.resolve(join(V5_WARDEN_REPORTS, REPORT));
  expect(state.investigations).toEqual([
    { id: 'i1', scope: 'session', origin: 'sweep', startedAt: AT, reportPath: moved, targetId: 'lead' },
    { id: 'i2', scope: 'fleet', origin: 'sweep', startedAt: AT },
  ]);
  expect((state.sweepCoverage as Record<string, unknown>).reportPath).toBe(moved);

  const remembered = RememberedFileSchema.parse(await read(V5_WARDEN_REMEMBERED));
  expect(JSON.parse(JSON.stringify(remembered.blessings))).toEqual([
    {
      ferret: 'child',
      kinds: ['dead_monitor', 'input_stuck'],
      expiresAt: LATER,
      by: 'owner',
      streak: 2,
      untilChange: true,
    },
    { ferret: 'lead', kinds: ['sus_thinking'], expiresAt: LATER, by: 'warden' },
  ]);

  expect(await everything(f.to)).not.toContain(FAKE_CAPABILITY);
  expect(JSON.stringify(report)).not.toContain(FAKE_CAPABILITY);
});

test('copies reports byte for byte with their mode, leaving a link behind unfollowed', async () => {
  const reports = join(f.from, 'state/warden/reports');
  await mkdir(reports, { recursive: true });
  await writeFile(join(reports, REPORT), '# FAKE report\n', { mode: 0o600 });
  await writeFile(join(reports, `${REPORT}.meta.json`), '{"agent":"fake"}\n');
  await chmod(join(reports, `${REPORT}.meta.json`), 0o640);
  await symlink('/nonexistent/FAKE-target.md', join(reports, 'link.md'));
  const report = await wardenStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'investigation reports and provenance files', count: 2 });
  expect(report.note).toContain('1 entr(ies) in the reports folder are not files: left behind');
  const to = join(f.to, V5_WARDEN_REPORTS);
  expect(await readFile(join(to, REPORT), 'utf8')).toBe('# FAKE report\n');
  expect((await stat(join(to, `${REPORT}.meta.json`))).mode & 0o777).toBe(0o640);
  expect((await readdir(to)).sort()).toEqual([REPORT, `${REPORT}.meta.json`]);
});

test('turns each day of Jev checks into one v5 document, skipping torn lines and other files', async () => {
  const checks = join(f.from, 'state/warden/jev-checks');
  await mkdir(checks, { recursive: true });
  const line = (n: number) => JSON.stringify({ at: AT, ferret: `f${String(n)}`, decision: 'leave' });
  await writeFile(join(checks, '2026-11-01.jsonl'), `${line(1)}\n${line(2)}\n{"FAKE-TORN\n\n`);
  await writeFile(join(checks, 'notes.txt'), 'not a day');
  const report = await wardenStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'Jev check days', count: 1 });
  expect(report.kept).toContainEqual({ what: 'Jev checks', count: 2 });
  expect(report.note).toContain('1 torn Jev check line(s) skipped');
  expect(JSON.stringify(report)).not.toContain('FAKE-TORN');
  const day = JevChecksFileSchema.parse(await read(join(V5_WARDEN_JEV_CHECKS, '2026-11-01.json')));
  expect(day).toEqual({
    format: 1,
    day: '2026-11-01',
    checks: [JSON.parse(line(1)), JSON.parse(line(2))],
  });
  expect(await readdir(join(f.to, V5_WARDEN_JEV_CHECKS))).toEqual(['2026-11-01.json']);
});

test('a home without a warden converts to nothing', async () => {
  const report = await wardenStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('a state document that is not an object fails naming the file, never its content', async () => {
  await f.put('state/warden/state.json', ['FAKE-CONTENT']);
  const report = await wardenStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/warden/state.json: is not a JSON object');
  expect(JSON.stringify(report)).not.toContain('FAKE-CONTENT');
});

test('a dry run counts and writes nothing', async () => {
  await f.put('state/warden/state.json', { lastSweepAt: AT });
  await f.put('state/warden/reports/x.md', 'FAKE');
  const report = await wardenStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.note).toStartWith('dry run: nothing written');
  expect(report.kept).toContainEqual({ what: 'investigation reports and provenance files', count: 1 });
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});
