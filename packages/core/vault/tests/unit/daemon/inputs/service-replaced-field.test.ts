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
  formId: 'verify',
  formName: 'verify-form',
  formAction: 'https://github.com/sessions/two-factor',
};
/** Where the browser proved the field's document is: the DevTools frame and that frame's loader. */
const PROVED = { ownerFrame: 'FRAME-1', ownerLoader: 'LOADER-1' };
const VALUE = '123456';

const shown = (): InputTargetFacts =>
  page({}, [pageField('code', { backendNodeId: 7, box: { x: 100, y: 200, w: 120, h: 32 }, ...PROVED }, ATTRS)]);

/** The page as it is after the swap: `over` says what else differs from the card. */
const swapped = (
  box: Partial<{ x: number; y: number; w: number; h: number }> = {},
  field: Partial<ReturnType<typeof pageField>> = {},
  facts: Parameters<typeof page>[0] = {},
  attrs: Record<string, string | undefined> = {},
): InputTargetFacts =>
  page(facts, [
    pageField(
      'code',
      { backendNodeId: 99, box: { x: 100, y: 200, w: 120, h: 32, ...box }, ...PROVED, ...field },
      Object.fromEntries(Object.entries({ ...ATTRS, ...attrs }).filter(([, value]) => value !== undefined)),
    ),
  ]);

/** A world whose page shows `shown()` at the raise and `after` once the card is up (the look and the re-find agree). */
async function sent(after: () => InputTargetFacts, ambiguous = false) {
  let now = shown();
  let stale = false;
  const w = world({
    // The agent's pointer is stale once the page was re-rendered, so only the re-find sees the page when `ambiguous`.
    observe: () => (stale ? { ok: false, reason: 'target_gone' } : { ok: true, facts: now, names: ['page-1'] }),
    refind: () => ({ ok: true, facts: now, names: ['page-1'], ...(ambiguous ? { ambiguous: true as const } : {}) }),
  });
  await w.service.raise(SESSION, RAISE);
  const request = await w.pending();
  now = after();
  stale = ambiguous;
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

/** A redraw is a rebound card with nothing typed and nothing counted: no `input.refused` is ever audited for it. */
const redrawn = async (w: Awaited<ReturnType<typeof sent>>['w'], deliver: () => Promise<unknown>): Promise<void> => {
  const error = await refusal(deliver());
  should((error as { reason?: string }).reason).equal('target_rebound');
  should(w.writes.length).equal(0);
  should(w.audits.map(entry => entry.event)).containEql('input.rebound');
  should(w.audits.map(entry => entry.event)).not.containEql('input.refused');
};

describe('a re-found field is typed into only on proof: anything unproved goes back to the owner', () => {
  it('should redraw, typing nothing, when the same-looking field now sits in a form that sends to another action', async () => {
    const { w, deliver } = await sent(() => swapped({}, {}, {}, { formAction: 'https://evil.example/collect' }));

    await redrawn(w, deliver);
  });

  it('should warn on the redrawn card that the form now sends to another origin (E-314)', async () => {
    const { w, deliver } = await sent(() => swapped({}, {}, {}, { formAction: 'https://evil.example/collect' }));

    await redrawn(w, deliver);

    const card = await w.pending();
    should(card.risk?.level).equal('amber');
    should(card.risk?.reason).containEql('another site than when you were asked');
  });

  it('should not warn when only the path of the same origin changed, or the card was not redrawn for its action (E-314)', async () => {
    const { w, deliver } = await sent(() =>
      swapped({}, {}, {}, { formAction: 'https://github.com/sessions/other-path', label: 'Code 2' }),
    );

    await redrawn(w, deliver);

    should((await w.pending()).risk?.reason ?? '').not.containEql('another site than when you were asked');
  });

  it('should redraw when another form now owns the field (a new id or name), or none does', async () => {
    for (const change of [
      { formId: 'other' },
      { formName: 'other' },
      { formId: undefined, formName: undefined, formAction: undefined },
    ]) {
      const { w, deliver } = await sent(() => swapped({}, {}, {}, change));

      await redrawn(w, deliver);
    }
  });

  it('should redraw, classified again, when the label became a card label: nothing is typed under the old kind', async () => {
    const { w, request, deliver } = await sent(() => swapped({}, {}, {}, { label: 'Card number' }));

    await redrawn(w, deliver);

    const card = (await w.pending()) ?? request;
    should(card.fields[0]?.sensitivity).equal('secret');
  });

  it('should redraw when the field is in another DevTools frame or another document of the frame, however alike', async () => {
    for (const moved of [{ ownerFrame: 'FRAME-2' }, { ownerLoader: 'LOADER-2' }]) {
      const { w, deliver } = await sent(() => swapped({}, moved));

      await redrawn(w, deliver);
    }
  });

  it('should redraw when the frame or the document of either sighting was not proved', async () => {
    for (const unproved of [{ ownerFrame: undefined }, { ownerLoader: undefined }, { unread: true as const }]) {
      const { w, deliver } = await sent(() => swapped({}, unproved));

      await redrawn(w, deliver);
    }
  });

  it('should redraw and count nothing for several look-alikes, again and again, never typing into one', async () => {
    const { w } = await sent(() => swapped({ x: 101 }), true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const request = await w.pending();
      const error = await refusal(
        w.service.deliver(SESSION, request.id, { ...w.send(request), padded: padInputValue(VALUE) }, OWNER),
      );
      should((error as { reason?: string }).reason).equal('target_rebound');
    }

    should(w.writes.length).equal(0);
    should(w.audits.map(entry => entry.event)).not.containEql('input.refused');
    should((await w.pending()).state).equal('pending');
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
    should(replacedAsShown(binding, shown(), swapped({}, {}, {}, { formAction: 'https://evil.example/x' }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, { ownerFrame: 'FRAME-2' }))).be.false();
    should(replacedAsShown(binding, shown(), swapped({}, { unread: true }))).be.false();
    should(replacedAsShown(binding, undefined, swapped())).be.false();
  });

  it('should say no when the number of fields differs', () => {
    should(replacedAsShown(binding, shown(), page({}, []))).be.false();
  });
});
