import { describe, expect, test } from 'bun:test';
import { FERRET, HISTORY, SESSION_FILES } from '../support/fake-ferrets.ts';
import { snapshotOf } from '../support/real-git.ts';
import { world } from '../support/world.ts';

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string; status?: number },
  );

describe('export stops the ferret politely, and complete turns the source into a stub that keeps every file', () => {
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
