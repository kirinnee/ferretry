import { describe, expect, test } from 'bun:test';
import { FERRET, HISTORY, SESSION_FILES, summaryOf } from '../support/fake-ferrets.ts';
import { snapshotOf } from '../support/real-git.ts';
import { world } from '../support/world.ts';

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string; status?: number },
  );

describe('export stops the ferret politely, and complete turns the source into a stub that keeps every file', () => {
  test('one handed-out chunk holds A past +16 minutes and completion can still be retried', async () => {
    const w = await world();
    const result = await w.relocation.export(FERRET, (await w.offer()).offer);
    w.relocation.chunk(result.exportId, 0);
    w.now += 16 * 60_000;
    await w.relocation.expire();
    expect(String(w.ferrets.state)).toBe('stopped');
    expect(w.ferrets.calls).not.toContain('resume');
    const completed = await w.relocation.complete(result.exportId, {
      to: { daemonId: w.targetIdentity.daemonId, ferretId: 'f-on-b' },
    });
    expect(completed.movedTo.ferretId).toBe('f-on-b');
  });
  test('expiry never resumes A after its durable fence when the moved-ledger answer fails', async () => {
    const w = await world({ recordFails: true });
    const result = await w.relocation.export(FERRET, (await w.offer()).offer);
    await expect(
      w.relocation.complete(result.exportId, {
        to: { daemonId: w.targetIdentity.daemonId, ferretId: 'f-on-b' },
      }),
    ).rejects.toThrow('moved ledger unavailable');
    w.now += 20 * 60_000;
    await w.relocation.expire();
    expect(String(w.ferrets.state)).toBe('stopped');
    expect(w.ferrets.calls).not.toContain('resume');
  });

  test('an idle ferret is stopped politely before it is read, and a stopped one is not stopped again', async () => {
    const idle = await world();
    await idle.relocation.export(FERRET, (await idle.offer()).offer);
    expect(idle.ferrets.calls).toEqual(['stop:polite']);
    const stopped = await world({ state: 'stopped' });
    await stopped.relocation.export(FERRET, (await stopped.offer()).offer);
    expect(stopped.ferrets.calls).toEqual([]);
  });

  test('complete records where the ferret went, keeps every file byte for byte, and frees the export', async () => {
    const w = await world();
    const treeBefore = snapshotOf(w.fixture.folder);
    const made = await w.offer();
    const result = await w.relocation.export(FERRET, made.offer);
    const done = await w.relocation.complete(result.exportId, {
      to: { daemonId: w.targetIdentity.daemonId, ferretId: 'f-on-b' },
    });
    expect(done.movedTo).toMatchObject({ daemonId: w.targetIdentity.daemonId, ferretId: 'f-on-b' });
    expect(w.movedLedger.get(FERRET)).toMatchObject({ ferretId: 'f-on-b' });
    // the source's own files are what they were: this plugin wrote nothing but its own record
    expect(snapshotOf(w.fixture.folder)).toEqual(treeBefore);
    for (const path of Object.keys(SESSION_FILES)) expect(w.source.reads.includes(`session:${path}`)).toBe(true);
    expect(HISTORY.length).toBeGreaterThan(0);
    expect(() => w.relocation.chunk(result.exportId, 0)).toThrow();
  });

  test('a ferret that was moved cannot be moved again, and its export is gone', async () => {
    const w = await world();
    const result = await w.relocation.export(FERRET, (await w.offer()).offer);
    await w.relocation.complete(result.exportId, { to: { daemonId: w.targetIdentity.daemonId, ferretId: 'f-on-b' } });
    expect(() => w.relocation.chunk(result.exportId, 0)).toThrow();
    expect((await refusal(w.relocation.preflight(FERRET, w.targetIdentity.daemonId)))?.code).toBe('already_moved');
  });

  test('complete for another machine than the one the export was sealed for is refused', async () => {
    const w = await world();
    const result = await w.relocation.export(FERRET, (await w.offer()).offer);
    const failed = await refusal(
      w.relocation.complete(result.exportId, { to: { daemonId: w.sourceIdentity.daemonId, ferretId: 'x' } }),
    );
    expect(failed?.code).toBe('wrong_target');
    expect(w.movedLedger.size).toBe(0);
  });

  test('only one export is held at a time, and an export is forgotten after its time', async () => {
    const w = await world();
    const first = await w.relocation.export(FERRET, (await w.offer()).offer);
    w.ferrets.state = 'idle';
    expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.code).toBe('export_busy');
    w.now += 20 * 60_000;
    expect(() => w.relocation.chunk(first.exportId, 0)).toThrow();
  });
});

test('explicit release after handoff expiry stops a manually resumed A and never revives it later', async () => {
  const w = await world();
  const first = await w.relocation.export(FERRET, (await w.offer()).offer);
  w.relocation.chunk(first.exportId, 0);
  w.now += 20 * 60_000;
  await w.relocation.expire();
  expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.code).toBe('export_busy');
  w.ferrets.state = 'idle';
  await w.relocation.release(FERRET);
  expect(String(w.ferrets.state)).toBe('stopped');
  w.now += 20 * 60_000;
  await w.relocation.expire();
  expect(String(w.ferrets.state)).toBe('stopped');
  expect(w.ferrets.calls).not.toContain('resume');
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).resolves.toHaveProperty('exportId');
});

test('release retains the reservation when A cannot confirm stop, and rejects completion while stopping', async () => {
  const w = await world();
  const first = await w.relocation.export(FERRET, (await w.offer()).offer);
  w.relocation.chunk(first.exportId, 0);
  w.ferrets.state = 'idle';
  const original = w.ferrets.port.stop;
  w.ferrets.port.stop = async () => {};
  await expect(w.relocation.release(FERRET)).rejects.toMatchObject({ code: 'source_unconfirmed' });
  expect((await refusal(w.relocation.export(FERRET, (await w.offer()).offer)))?.code).toBe('export_busy');
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(r => (enter = r));
  const held = new Promise<void>(r => (finish = r));
  w.ferrets.port.stop = async () => {
    enter();
    await held;
    w.ferrets.state = 'stopped';
  };
  const releasing = w.relocation.release(FERRET);
  await entered;
  await expect(w.relocation.release(FERRET)).rejects.toMatchObject({ code: 'export_busy' });
  await expect(
    w.relocation.complete(first.exportId, { to: { daemonId: w.targetIdentity.daemonId, ferretId: 'held' } }),
  ).rejects.toMatchObject({ code: 'export_busy' });
  finish();
  await releasing;
  w.ferrets.port.stop = original;
  expect(String(w.ferrets.state)).toBe('stopped');
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).resolves.toHaveProperty('exportId');
});

test('releasing a different ferret does not claim the global slot is free or stop an unrelated record', async () => {
  const w = await world();
  const first = await w.relocation.export(FERRET, (await w.offer()).offer);
  w.relocation.chunk(first.exportId, 0);
  const get = w.ferrets.port.get;
  w.ferrets.port.get = async id =>
    id === 'other' ? { ...summaryOf('idle'), id: 'other' as typeof FERRET } : await get(id);
  const before = [...w.ferrets.calls];
  await expect(w.relocation.release('other')).rejects.toMatchObject({ code: 'export_busy' });
  expect(w.ferrets.calls).toEqual(before);
  expect(w.relocation.chunk(first.exportId, 0).length).toBeGreaterThan(0);
  await expect(w.relocation.release(FERRET)).resolves.toEqual({ state: 'stopped' });
});
