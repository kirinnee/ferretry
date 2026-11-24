import { describe, it } from 'bun:test';
import should from 'should';
import type { InputRaise, InputTargetFacts } from '../../../../contract/index.ts';
import { REPLACED_FIELD_TOLERANCE_PX, replacedAsShown, bindingOf } from '../../../../daemon/lib/inputs/rebind.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { page, pageField, SESSION } from './grant-fixtures.ts';
import { OWNER, refusal, world } from './world.ts';

/**
 * A page that re-renders its input while the owner reads the card (a React-style swap: a new node behind the same
 * selector). The ONE element that is provably the same field is typed into at once; anything less sure is redrawn for the
 * owner. The page and the browser's re-find are fakes here; the real browser half is Browsers' own Chrome test.
 */

const RAISE: InputRaise = {
  target: { kind: 'page', key: 'app' },
  prompt: 'GitHub asks for a value',
  fields: [{ id: 'code', label: 'Code', sensitivity: 'plain', element: { kind: 'selector', selector: '#field' } }],
  submit: 'owner-default',
};
const ATTRS: Record<string, string> = {
  name: 'otp',
  autocomplete: 'one-time-code',
  inputmode: 'numeric',
  maxlength: '6',
  label: 'Code',
};
const VALUE = '123456';

const shown = (): InputTargetFacts =>
  page({}, [pageField('code', { backendNodeId: 7, box: { x: 100, y: 200, w: 120, h: 32 } }, ATTRS)]);

/** The page as it is after the swap: `over` says what else differs from the card. */
const swapped = (
  box: Partial<{ x: number; y: number; w: number; h: number }> = {},
  field: Partial<ReturnType<typeof pageField>> = {},
  facts: Parameters<typeof page>[0] = {},
  attrs: Record<string, string> = {},
): InputTargetFacts =>
  page(facts, [
    pageField(
      'code',
      { backendNodeId: 99, box: { x: 100, y: 200, w: 120, h: 32, ...box }, ...field },
      { ...ATTRS, ...attrs },
    ),
  ]);

/** A world whose page shows `shown()` at the raise and `after` once the card is up (the look and the re-find agree). */
async function sent(after: () => InputTargetFacts) {
  let now = shown();
  const w = world({
    facts: () => now,
    refind: () => ({ ok: true, facts: now, names: ['page-1'] }),
  });
  await w.service.raise(SESSION, RAISE);
  const request = await w.pending();
  now = after();
  const body = { ...w.send(request), padded: padInputValue(VALUE) };
  return { w, request, deliver: () => w.service.deliver(SESSION, request.id, body, OWNER) };
}

describe('a field the page re-rendered under the card', () => {
  it('should type into the ONE replaced element at once: one write, no second send', async () => {
    const { w, deliver } = await sent(() => swapped({ x: 104, y: 198 }));

    await deliver();

    should(w.writes.map(write => write.values)).eql([[VALUE]]);
  });

  it('should type into the same node when only its box moved a little', async () => {
    const { w, deliver } = await sent(() => swapped({ y: 200 + REPLACED_FIELD_TOLERANCE_PX }, { backendNodeId: 7 }));

    await deliver();

    should(w.writes.length).equal(1);
  });

  it('should redraw, typing nothing, when the replacement sits farther than the tolerance', async () => {
    const { w, deliver } = await sent(() => swapped({ y: 200 + REPLACED_FIELD_TOLERANCE_PX + 1 }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should redraw when the replacement is much bigger or smaller than the field shown', async () => {
    const { w, deliver } = await sent(() => swapped({ w: 120 + REPLACED_FIELD_TOLERANCE_PX + 1 }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should redraw when the page navigated (another document), however alike its field looks', async () => {
    const { w, deliver } = await sent(() => swapped({}, {}, { navigationId: 'n2' }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should redraw when the field moved to another frame', async () => {
    const { w, deliver } = await sent(() => swapped({}, { frameId: 'iframe-2' }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should redraw when a challenge appeared on the page', async () => {
    const { w, deliver } = await sent(() => swapped({}, {}, { challenge: { provider: 'recaptcha' } as never }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should redraw when something now covers a field that was clear', async () => {
    const { w, deliver } = await sent(() => swapped({}, { covered: true }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_rebound');
    should(w.writes.length).equal(0);
  });

  it('should count a failed check, not redraw, when the replacement is not the same kind of field', async () => {
    const { w, deliver } = await sent(() => swapped({}, {}, {}, { autocomplete: 'off' }));

    const error = await refusal(deliver());

    should((error as { reason?: string }).reason).equal('target_changed');
    should(w.writes.length).equal(0);
  });

  it('should type nothing when the browser cannot find ONE such element (none, or several look-alikes)', async () => {
    let now = shown();
    const w = world({ facts: () => now, refind: () => ({ ok: false, reason: 'target_gone' }) });
    await w.service.raise(SESSION, RAISE);
    const request = await w.pending();
    now = swapped();

    const error = await refusal(
      w.service.deliver(SESSION, request.id, { ...w.send(request), padded: padInputValue(VALUE) }, OWNER),
    );

    should((error as { reason?: string }).reason).equal('target_changed');
    should(w.writes.length).equal(0);
  });
});

describe('replacedAsShown', () => {
  const binding = bindingOf(shown());

  it('should say yes only for the same binding, document and frames, near where the field was', () => {
    should(replacedAsShown(binding, shown(), swapped({ x: 110, y: 190 }))).be.true();
    should(replacedAsShown(binding, shown(), swapped({ x: 100 + REPLACED_FIELD_TOLERANCE_PX + 1 }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, {}, { navigationId: 'n2' }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, {}, { origin: 'https://evil.example' }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, { visible: false }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, {}, {}, { maxlength: '8' }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, {}, {}, { label: 'Password' }))).be.false();
    should(replacedAsShown(binding, undefined, swapped())).be.false();
  });

  it('should say no when the number of fields differs', () => {
    should(replacedAsShown(binding, shown(), page({}, []))).be.false();
  });
});
