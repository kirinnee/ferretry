/**
 * A converted ferret carries how it ended (`cause`, read by Usage's insights as completed / failed / stopped) and the login
 * its v4 runtime named (`login`, the insights Agent column). The Warden DOES read `cause` to decide a revive, so a converted
 * cause must never be one it revives (golden below, then the Warden's own reading of every converted record).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type FerretSummary, FerretRecordSchema, FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyEnd } from '../../../../packages/plugins/warden/daemon/lib/index.ts';
import { reviveEventsOf } from '../../../../packages/plugins/warden/daemon/fleet.ts';
import { ferretsStep } from '../../src/steps/ferrets.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const record = async (id: string) =>
  FerretRecordSchema.parse(JSON.parse(await readFile(join(f.to, 'state/ferrets', id, 'ferret.json'), 'utf8')));

const runtimeFile = async (name: string, text: string) => {
  await mkdir(join(f.from, 'config/runtimes'), { recursive: true });
  await writeFile(join(f.from, 'config/runtimes', `${name}.yaml`), text);
};

const CASES = [
  ['completed', { kind: 'completed' }],
  ['stopped', { kind: 'stopped' }],
  ['interrupted', { kind: 'stopped' }],
  ['failed', { kind: 'start_failed' }],
  ['stalled', { kind: 'start_failed' }],
] as const;

test('writes the cause a v4 ferret ended with, and none for one that has not ended', async () => {
  for (const [status] of CASES) {
    await f.session(`s-${status}`, { harness: 'claude', agent: '/old/fleet/bin/claude-work' });
    await f.put(`state/sessions/s-${status}/state.json`, { id: `s-${status}`, status, turn: 3, finishedAt: AT });
  }
  await f.session('live', { harness: 'claude', agent: '/old/fleet/bin/claude-work' });
  await f.put('state/sessions/live/state.json', { id: 'live', status: 'thinking', turn: 0, lastActivityAt: AT });
  await f.pane('live');
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  for (const [status, cause] of CASES) expect((await record(`s-${status}`)).cause).toEqual(cause);
  expect((await record('live')).cause).toBeUndefined();
});

test('the Warden revives no converted ferret, whatever it ended with', async () => {
  for (const [status] of CASES) {
    await f.session(`s-${status}`, { harness: 'claude', agent: '/old/fleet/bin/claude-work' });
    await f.put(`state/sessions/s-${status}/state.json`, { id: `s-${status}`, status, turn: 3, finishedAt: AT });
  }
  await ferretsStep.run(f.ctx());
  for (const [status] of CASES) {
    const stored = await record(`s-${status}`);
    const { format: _format, handle: _handle, ...rest } = stored;
    const summary: FerretSummary = FerretSummarySchema.parse(rest);
    const verdict = classifyEnd('failed', reviveEventsOf(summary));
    expect(verdict.kind).toBe('leave');
  }
});

test('writes the login the v4 runtime names, and none for a runtime that names no valid one', async () => {
  await runtimeFile('claude-work', 'credential: work-login\nprofile: base\n');
  await runtimeFile('claude-odd', 'credential: Not A Login\n');
  await f.session('a', { harness: 'claude', agent: '/old/fleet/bin/claude-work' });
  await f.session('b', { harness: 'claude', agent: '/old/fleet/bin/claude-odd' });
  await f.session('c', { harness: 'claude', agent: '/old/fleet/bin/claude-gone' });
  for (const id of ['a', 'b', 'c']) await f.put(`state/sessions/${id}/state.json`, { id, status: 'stopped', turn: 0 });
  expect((await ferretsStep.run(f.ctx())).status).toBe('converted');
  expect((await record('a')).login).toBe('work-login');
  expect((await record('b')).login).toBeUndefined();
  expect((await record('c')).login).toBeUndefined();
});
