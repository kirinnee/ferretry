import { expect, test } from 'bun:test';
import { targetRef } from '@ferretry/core-vault/contract';
import { ferretId } from '../../../../contract/testing/index.ts';
import { ActingRunner, additivesFixture } from './additives-fixture.ts';

async function running(options: Parameters<typeof additivesFixture>[0] = {}) {
  const f = additivesFixture(options);
  await f.service.resume(f.id);
  const handle = (await f.service.handle(f.id))!;
  const seam = (await f.service.harness(f.id))!;
  return { ...f, handle, seam };
}

test('decision 18: deliver is the runner’s own delivery, which guards its writes itself; the seam adds no second act', async () => {
  const f = await running();
  const answer = await f.seam.deliver({ text: 'hello there' });
  expect(answer).toEqual({ ok: true, value: 'turn-started' });
  expect(f.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['hello there']);
  // The seam itself acted nothing: wrapping the runner's guarded writes in an act of its own would wait on itself.
  expect(f.acted).toEqual([]);
});

test('decision 18: deliver settles against a QUEUEING act runner and a runner that acts per write (no deadlock)', async () => {
  const f = await running({ queueing: { held: new Set() } });
  const settled = await Promise.race([
    f.seam.deliver({ text: 'hello there' }),
    new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 1_000)),
  ]);
  expect(settled).toEqual({ ok: true, value: 'turn-started' });
  expect((f.runner as ActingRunner).typed).toEqual(['load-buffer', 'paste-buffer', 'send-keys']);
  // The pane's queue is not wedged: a later act on the same pane, and a second delivery, still run.
  const later = await f.ports.act!(targetRef('terminal', f.handle), 'keys', async () => ({ status: 'done' as const }));
  expect(later.ok).toBe(true);
  expect(await f.seam.deliver({ text: 'again' })).toEqual({ ok: true, value: 'turn-started' });
});

test('decision 18: a held pane refuses a delivery before any keys, and a later act on the pane still works once released', async () => {
  const held = new Set<string>();
  const f = await running({ queueing: { held } });
  held.add(f.handle);
  await expect(f.seam.deliver({ text: 'secret-adjacent' })).rejects.toThrow('refused');
  expect((f.runner as ActingRunner).typed).toEqual([]);
  expect(f.runner.deliveries).toEqual([]);
  held.delete(f.handle);
  expect(await f.seam.deliver({ text: 'now allowed' })).toEqual({ ok: true, value: 'turn-started' });
  expect(f.runner.deliveries.map(entry => entry.delivery.text)).toEqual(['now allowed']);
});

test('decision 18: interrupt goes through kernel.act on the ferret’s pane, as keys, and signals the runner', async () => {
  const f = await running();
  expect(await f.seam.interrupt()).toEqual({ ok: true, value: true });
  expect(f.acted).toEqual([{ target: targetRef('terminal', f.handle), op: 'keys' }]);
  expect(f.runner.signals).toEqual([{ handle: f.handle, signal: 'interrupt' }]);
});

test('decision 18: interrupt settles and is refused by a hold on a queueing act runner', async () => {
  const held = new Set<string>();
  const f = await running({ queueing: { held } });
  expect(await f.seam.interrupt()).toEqual({ ok: true, value: true });
  held.add(f.handle);
  expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'held' } });
  expect(f.runner.signals).toHaveLength(1);
});

test('decision 18: a hold the act runner applies stops an interrupt; nothing reaches the pane', async () => {
  const f = await running();
  f.control.refuse = 'held';
  expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'held' } });
  expect(f.runner.signals).toEqual([]);
});

test('decision 18: with no act runner bound an interrupt is refused (fail closed), never sent raw', async () => {
  const f = await running();
  delete f.ports.act;
  expect(await f.seam.interrupt()).toEqual({ ok: false, error: { refused: 'holds_unavailable' } });
  expect(f.runner.signals).toEqual([]);
});

test('decision 18: the seam offers deliver, queue (U3), interrupt and transcript only; no raw pane write exists', async () => {
  const f = await running();
  expect(Object.keys(f.seam).sort()).toEqual(['deliver', 'interrupt', 'queue', 'transcript']);
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
  expect(await f.seam.transcript.read()).toEqual([entry]);
  expect(await f.seam.transcript.find('e1')).toEqual(entry);
});

test('decision 18: a ferret’s own seam reads only ITS OWN transcript, never another ferret’s', async () => {
  const f = additivesFixture();
  const stranger = ferretId('stranger');
  f.registry.put({ ...f.registry.get(f.id)!, id: stranger, name: 'stranger' });
  const asked: string[] = [];
  (f.harness as { transcript: unknown }).transcript = {
    read: async (ferret: string) => {
      asked.push(ferret);
      return [
        {
          id: ferret,
          at: '2026-11-07T00:00:00.000Z' as never,
          role: 'assistant' as const,
          text: `secret of ${ferret}`,
        },
      ];
    },
    follow: async function* (ferret: string) {
      asked.push(ferret);
      // A ferret with nothing to follow: the stream ends at once.
      yield* [];
    },
    find: async (ferret: string) => {
      asked.push(ferret);
      return undefined;
    },
  };
  // The direct way is refused: a ferret opening a stranger's seam.
  await expect(f.service.harness(stranger, f.id)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  const own = (await f.service.harness(f.id, f.id))!;
  // The reader has no ferret argument. A stranger's id passed anyway lands in `after`, and the harness reader is still
  // asked about the seam's own ferret only.
  const read = own.transcript.read as unknown as (...args: unknown[]) => Promise<{ text: string }[]>;
  const entries = await read(stranger);
  expect(entries.map(entry => entry.text)).toEqual([`secret of ${f.id}`]);
  await own.transcript.find('e1');
  for await (const _entry of own.transcript.follow(new AbortController().signal)) void _entry;
  expect(asked).toEqual([f.id, f.id, f.id]);
  expect(asked).not.toContain(stranger);
  expect(own.transcript.read.length).toBeLessThanOrEqual(2);
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
