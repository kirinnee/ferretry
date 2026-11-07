import { expect, test } from 'bun:test';
import { targetRef } from '@ferretry/core-vault/contract';
import { ferretId } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

async function running() {
  const f = additivesFixture();
  await f.service.resume(f.id);
  const handle = (await f.service.handle(f.id))!;
  const seam = (await f.service.harness(f.id))!;
  return { ...f, handle, seam };
}

test('decision 18: deliver goes through kernel.act on the ferret’s terminal pane, as keys', async () => {
  const f = await running();
  const answer = await f.seam.deliver({ text: 'hello there' });
  expect(answer).toEqual({ ok: true, value: 'turn-started' });
  expect(f.acted).toHaveLength(1);
  expect(f.acted[0]!.op).toBe('keys');
  expect(f.acted[0]!.target).toEqual(targetRef('terminal', f.handle));
  expect(f.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['hello there']);
});

test('decision 18: interrupt goes through kernel.act on the same pane and signals the runner', async () => {
  const f = await running();
  expect(await f.seam.interrupt()).toEqual({ ok: true, value: true });
  expect(f.acted).toEqual([{ target: targetRef('terminal', f.handle), op: 'keys' }]);
  expect(f.runner.signals).toEqual([{ handle: f.handle, signal: 'interrupt' }]);
});

test('decision 18: a hold the act runner applies stops the write; nothing reaches the pane', async () => {
  const f = await running();
  f.control.refuse = 'held';
  expect(await f.seam.deliver({ text: 'secret-adjacent' })).toEqual({ ok: false, error: { refused: 'held' } });
  expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'held' } });
  expect(f.runner.deliveries).toEqual([]);
  expect(f.runner.signals).toEqual([]);
});

test('decision 18: with no act runner bound the seam refuses every write (fail closed), never writes raw', async () => {
  const f = await running();
  delete f.ports.act;
  expect(await f.seam.deliver({ text: 'x' })).toEqual({ ok: false, error: { refused: 'holds_unavailable' } });
  expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'holds_unavailable' } });
  expect(f.runner.deliveries).toEqual([]);
  expect(f.runner.signals).toEqual([]);
});

test('decision 18: the seam offers deliver, interrupt and transcript only; no raw pane write exists', async () => {
  const f = await running();
  expect(Object.keys(f.seam).sort()).toEqual(['deliver', 'interrupt', 'transcript']);
  expect(Object.keys(f.seam.transcript).sort()).toEqual(['find', 'follow', 'read']);
});

test('decision 18: a ferret that stopped since has no pane to act on', async () => {
  const f = await running();
  await f.service.stop(f.id, 'now');
  expect(await f.seam.deliver({ text: 'late' })).toEqual({ ok: false, error: { refused: 'no_pane' } });
  expect(f.acted).toEqual([]);
});

test('decision 18: the transcript is read through the ferret’s harness', async () => {
  const f = await running();
  const entry = { id: 'e1', at: '2026-11-07T00:00:00.000Z' as never, role: 'assistant' as const, text: 'hi' };
  (f.harness as { transcript: unknown }).transcript = {
    read: async () => [entry],
    follow: async function* () {},
    find: async () => entry,
  };
  expect(await f.seam.transcript.read(f.id)).toEqual([entry]);
  expect(await f.seam.transcript.find(f.id, 'e1')).toEqual(entry);
});

test('decision 18: a ferret caller reaches its own and its helpers’ harness, nobody else’s', async () => {
  const f = additivesFixture();
  const lead = ferretId('lead');
  const helper = ferretId('helper');
  const other = ferretId('other');
  const base = f.registry.get(f.id)!;
  f.registry.put({ ...base, id: lead, name: 'lead' });
  f.registry.put({ ...base, id: helper, name: 'helper', parent: lead, role: 'helper' });
  f.registry.put({ ...base, id: other, name: 'other' });
  expect(await f.service.harness(lead, lead)).toBeDefined();
  expect(await f.service.harness(helper, lead)).toBeDefined();
  await expect(f.service.harness(other, lead)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  await expect(f.service.harness(lead, helper)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  // The owner (no caller) reaches any; an unknown ferret has none.
  expect(await f.service.harness(other)).toBeDefined();
  expect(await f.service.harness(ferretId('nobody'), lead)).toBeUndefined();
});
