import { describe, expect, test } from 'bun:test';
import type { FerretHarness, FerretId, RunnerHandle } from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * A record whose runner handle is a pane id that now belongs to ANOTHER ferret (`oak`): a converted v4 ferret's `%N`, or one
 * from before a tmux-server restart. Everything the ferret's harness seam does through that handle (type a send, queue
 * one, press the stop key, press a form key, read the pane) used to reach `oak`: a message for `fern` typed into `oak`'s
 * harness. Each is now refused as for a pane that is gone, with NOTHING typed, pressed or read, so the message stays
 * where it was (the mailbox keeps a `stopped`/`exited` refusal queued for the relaunch).
 */
async function staleHandleFixture() {
  const f = additivesFixture();
  const other = ferretId('oak') as FerretId;
  const handle: RunnerHandle = f.runner.adoptable(other);
  const record = f.registry.get(f.id);
  if (record === undefined) throw new Error('the fixture ferret is missing');
  f.registry.put({ ...record, state: 'working', handle, mode: 'interactive' });
  const seam = (await f.service.harness(f.id)) as Required<FerretHarness>;
  const otherSeam = (() => {
    const oak = f.registry.get(f.id);
    if (oak === undefined) throw new Error('the fixture ferret is missing');
    f.registry.put({ ...oak, id: other, handle, state: 'working', mode: 'interactive' });
    return f.service.harness(other);
  })();
  return { f, handle, seam, otherSeam: (await otherSeam)! };
}

const GONE = { ok: false, error: { refused: 'not_ready', why: 'exited' } } as const;

describe('a stale handle through the harness seam reaches nobody', () => {
  test('a send is not typed into the other ferret, and is refused as a gone pane (so it stays queued)', async () => {
    const { f, seam } = await staleHandleFixture();

    expect(await seam.deliver({ text: 'for fern' })).toEqual(GONE);
    expect(await seam.queue('for fern')).toEqual(GONE);

    expect(f.runner.deliveries).toEqual([]);
    expect(f.runner.queued).toEqual([]);
  });

  test('an interrupt does not press the other ferret’s stop key', async () => {
    const { f, seam } = await staleHandleFixture();

    expect(await seam.interrupt()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(await seam.stopActive()).toEqual({ ok: false, error: { refused: 'no_pane' } });

    expect(f.runner.pressed).toEqual([]);
    expect(f.runner.stops).toEqual([]);
  });

  test('the composer and form acts reach nobody, and the pane reads as not there', async () => {
    const { f, seam } = await staleHandleFixture();

    expect(await seam.clearComposer('x')).toEqual(GONE);
    expect(await seam.submitComposer('x')).toEqual(GONE);
    expect(await seam.form.key('Enter')).toEqual(GONE);
    expect(await seam.form.pickerKey?.('1')).toEqual(GONE);
    expect(await seam.form.paste('x')).toEqual(GONE);
    expect(await seam.observe()).toEqual({ ok: false, error: { refused: 'no_pane' } });
    expect(await seam.form.capture()).toEqual({ ok: false, error: { refused: 'no_pane' } });

    expect(f.runner.cleared).toEqual([]);
    expect(f.runner.submitted).toEqual([]);
    expect(f.runner.formKeys).toEqual([]);
    expect(f.runner.pickerKeys).toEqual([]);
    expect(f.runner.formPastes).toEqual([]);
  });

  test('the pane’s own ferret still gets its send (an adopted pane has the same session name)', async () => {
    const { f, handle, otherSeam } = await staleHandleFixture();

    expect(await otherSeam.deliver({ text: 'for oak' })).toEqual({ ok: true, value: 'turn-started' });

    expect(f.runner.deliveries.map(entry => [entry.handle, entry.delivery.text])).toEqual([[handle, 'for oak']]);
  });
});
