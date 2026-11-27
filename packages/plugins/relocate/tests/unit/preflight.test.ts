import { describe, expect, test } from 'bun:test';
import { RELOCATE_MAX_BUNDLE_BYTES, RELOCATE_MAX_FILE_BYTES } from '../../contract/index.ts';
import { FERRET } from '../support/fake-ferrets.ts';
import { world } from '../support/world.ts';

const refusal = async (promise: Promise<unknown>) =>
  await promise.then(
    () => undefined,
    (error: unknown) => error as Error & { code?: string; status?: number },
  );

describe('preflight lists what would move and says whether it could', () => {
  test('an idle ferret in a git tree is ok, with both tables, counts and the branch', async () => {
    const w = await world();
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.ok).toBe(true);
    expect(view.refusals).toEqual([]);
    expect(view.moves.length).toBeGreaterThan(5);
    expect(view.stays.map(row => row.id)).toContain('session-credential');
    expect(view.branch).toBe('main');
    expect(view.head).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(view.files).toBeGreaterThan(5);
    // a preflight reads sizes, never the files themselves, and stops nothing
    expect(w.source.reads).toEqual([]);
    expect(w.ferrets.calls).toEqual([]);
  });

  test('a ferret with an attached job or a queued message is refused, with nothing stopped', async () => {
    const w = await world({ busy: ['1 background job is still running; a job cannot move'] });
    const made = await w.offer();
    const view = await w.relocation.preflight(FERRET, made.offer.daemonId);
    expect(view.ok).toBe(false);
    expect(view.refusals).toEqual(['1 background job is still running; a job cannot move']);
    const failed = await refusal(w.relocation.export(FERRET, made.offer));
    expect(failed?.code).toBe('move_refused');
    expect(w.ferrets.calls).toEqual([]);
    expect(w.source.reads).toEqual([]);
  });

  test('a harness that cannot pack its conversation is refused at preflight, naming why', async () => {
    const w = await world({
      conversation: { ok: false, error: { reason: 'this ferret’s harness cannot pack it yet' } },
    });
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.ok).toBe(false);
    expect(view.refusals).toContain('this ferret’s harness cannot pack it yet');
  });

  test('a bundle over the cap, and a file over the file cap, are refused and the largest are named', async () => {
    const w = await world({
      size: path => (path === 'attachments/a1/photo.txt' ? RELOCATE_MAX_BUNDLE_BYTES + 1 : undefined),
    });
    const view = await w.relocation.preflight(FERRET, (await w.offer()).offer.daemonId);
    expect(view.ok).toBe(false);
    expect(view.refusals.join(' ')).toContain('MB');
    expect(view.largest[0]).toEqual({ path: 'attachments/a1/photo.txt', size: RELOCATE_MAX_BUNDLE_BYTES + 1 });
    const one = await world({
      size: path => (path === 'attachments/a1/photo.txt' ? RELOCATE_MAX_FILE_BYTES + 1 : undefined),
    });
    const alone = await one.relocation.preflight(FERRET, (await one.offer()).offer.daemonId);
    expect(alone.refusals.join(' ')).toContain('attachments/a1/photo.txt is larger than one file');
  });

  test('a machine cannot move a ferret to itself, and a ferret this machine does not know is not found', async () => {
    const w = await world();
    expect((await refusal(w.relocation.preflight(FERRET, w.sourceIdentity.daemonId)))?.code).toBe('same_machine');
    expect((await refusal(w.relocation.preflight('nobody', w.targetIdentity.daemonId)))?.code).toBe('not_found');
  });
});
