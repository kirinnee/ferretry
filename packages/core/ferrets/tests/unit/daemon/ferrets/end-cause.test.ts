import { expect, test } from 'bun:test';
import { FerretEndCauseSchema, FerretSummarySchema } from '../../../../contract/index.ts';
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
