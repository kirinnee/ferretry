import { expect, test } from 'bun:test';
import {
  type FerretChangedPayload,
  type FerretEndCause,
  FerretEndCauseSchema,
  FerretSummarySchema,
} from '../../../../contract/index.ts';
import { T0 } from '../../../../contract/testing/index.ts';
import { summaryOf } from '../../../../daemon/lib/registry/registry.ts';
import { additivesFixture } from './additives-fixture.ts';

test('death cause: today’s words parse, anything else does not', () => {
  for (const cause of [
    { kind: 'tmux_crashed' },
    { kind: 'terminal_gone' },
    { kind: 'signal', signal: 9 },
    { kind: 'agent_crashed', exitCode: 2 },
    { kind: 'stopped' },
    { kind: 'completed' },
    { kind: 'start_failed' },
    { kind: 'clean_exit' },
  ])
    expect(FerretEndCauseSchema.safeParse(cause).success).toBe(true);
  expect(FerretEndCauseSchema.safeParse({ kind: 'oom' }).success).toBe(false);
  expect(FerretEndCauseSchema.safeParse({ kind: 'signal', signal: 0 }).success).toBe(false);
});

test('death cause: a stopped ferret says it was stopped; resuming clears it; a running ferret has none', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  expect((await f.service.get(f.id))?.cause).toBeUndefined();
  await f.service.stop(f.id, 'now');
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'stopped' });
  await f.service.resume(f.id);
  expect((await f.service.get(f.id))?.cause).toBeUndefined();
});

test('death cause: signal done ends the ferret as completed', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  await f.service.stop(f.id, 'now', 'done', { kind: 'completed' });
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'completed' });
});

test('death cause: a launch that failed ends as start_failed', async () => {
  const f = additivesFixture();
  f.ports.runner = () => undefined;
  const failed = await f.service.resume(f.id);
  expect(failed.ok).toBe(false);
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'start_failed' });
});

test('death cause: the summary schema carries it, and a later cause replaces the earlier one', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  await f.service.stop(f.id, 'now');
  const summary = (await f.service.get(f.id))!;
  expect(FerretSummarySchema.safeParse(summary).success).toBe(true);
  const record = f.registry.get(f.id)!;
  expect(summaryOf({ ...record, cause: { kind: 'signal', signal: 9 } }).cause).toEqual({ kind: 'signal', signal: 9 });
  expect(summaryOf({ ...record, stateAt: T0 }).cause).toEqual({ kind: 'stopped' });
});

test('death cause: adopting a live process clears a stopped ferret’s end cause; the cause is present only while stopped', async () => {
  const f = additivesFixture();
  await f.service.resume(f.id);
  await f.service.stop(f.id, 'now', 'done', { kind: 'completed' });
  expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'completed' });
  const adopted = await f.service.attach(f.id, f.runner.adoptable(f.id));
  expect(adopted.ok).toBe(true);
  const summary = await f.service.get(f.id);
  expect(summary?.state).toBe('working');
  expect(summary?.cause).toBeUndefined();
  expect('cause' in f.registry.get(f.id)!).toBe(false);
});

/** The fixture's ferret, already stopped for `cause` (what the boot pass, a crash or a failed launch left it as). */
function stoppedFor(cause: FerretEndCause | undefined) {
  const f = additivesFixture();
  const { cause: _none, ...record } = f.registry.get(f.id)!;
  f.registry.put({ ...record, state: 'stopped', ...(cause === undefined ? {} : { cause }) });
  const changes: FerretChangedPayload[] = [];
  f.ports.changed = change => changes.push(change);
  return { ...f, changes };
}

const FAILED: readonly FerretEndCause[] = [
  { kind: 'terminal_gone' },
  { kind: 'tmux_crashed' },
  { kind: 'signal', signal: 9 },
  { kind: 'agent_crashed', exitCode: 2 },
  { kind: 'start_failed' },
];

for (const failed of FAILED)
  for (const how of ['polite', 'now'] as const)
    test(`W2-a death cause: a ${how} stop of a ferret that ended ${failed.kind} is the caller's decision and is written over it`, async () => {
      const f = stoppedFor(failed);
      await f.service.stop(f.id, how, 'the owner said so');
      expect((await f.service.get(f.id))?.cause).toEqual({ kind: 'stopped' });
      expect(f.registry.get(f.id)?.state).toBe('stopped');
      expect(f.history).toEqual([{ type: 'session.stopped', data: { reason: 'the owner said so' } }]);
      expect(f.changes).toEqual([{ ferret: f.id, state: 'stopped', previous: 'stopped', change: 'stopped' }]);
    });

test("W2-a death cause: another plugin's stop (the port) and a `signal done` are written over terminal_gone too", async () => {
  const port = stoppedFor({ kind: 'terminal_gone' });
  await port.api.stop(port.id, 'polite');
  expect((await port.service.get(port.id))?.cause).toEqual({ kind: 'stopped' });
  expect(port.history).toEqual([{ type: 'session.stopped', data: { reason: 'stopped by client' } }]);
  const done = stoppedFor({ kind: 'terminal_gone' });
  await done.service.stop(done.id, 'now', 'done', { kind: 'completed' });
  expect((await done.service.get(done.id))?.cause).toEqual({ kind: 'completed' });
});

for (const decided of [{ kind: 'stopped' }, { kind: 'completed' }, { kind: 'clean_exit' }, undefined] as const)
  test(`W2-a death cause: a stop of a ferret that already ended ${decided?.kind ?? 'with no cause'} changes nothing`, async () => {
    const f = stoppedFor(decided);
    const before = f.registry.get(f.id);
    await f.service.stop(f.id, 'now', 'again');
    expect(f.registry.get(f.id)).toEqual(before!);
    expect(f.history).toEqual([]);
    expect(f.changes).toEqual([]);
  });
