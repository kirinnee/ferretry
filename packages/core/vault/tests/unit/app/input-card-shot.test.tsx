/**
 * The input card draws the page-field picture the daemon holds for the owner: one read of the shot route per request
 * while the card is on screen, the image and one box per field, nothing when there is no picture, and the bytes gone
 * when the card goes away. The picture is a fake 1-pixel PNG; no value is involved anywhere.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InputCard } from '../../../app/features/input/input-card.tsx';
import { InputShotSchema } from '../../../contract/index.ts';
import { settle } from '../../support/app/dom-form.ts';
import { mount, must } from '../../support/app/dom.ts';
import { pageRequest, REQUEST_ID, recordingClient, terminalRequest } from '../../support/app/input-fixtures.ts';

const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const SHOT = { pngBase64: PNG, clip: { x: 0, y: 0, w: 100, h: 100 } };
const SHOT_ROUTE = 'GET /v1/ferrets/:ferretId/input-requests/:requestId/shot';

const q = <T extends Element>(root: ParentNode, selector: string): T => must(root.querySelector<T>(selector), selector);
const shotCalls = <T extends { readonly route: string }>(calls: readonly T[]): T[] =>
  calls.filter(call => call.route === SHOT_ROUTE);

const live: { unmount: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const mounted of live.splice(0)) await mounted.unmount();
});

async function card(request: ReturnType<typeof pageRequest>, answer: () => unknown = () => SHOT) {
  const rig = recordingClient(async route => (route === SHOT_ROUTE ? await answer() : {}));
  const mounted = await mount(<InputCard client={rig.client} now={NOW} onDone={() => undefined} request={request} />);
  live.push(mounted);
  await settle();
  return { ...rig, mounted };
}

describe('the page-field picture on the input card', () => {
  it('reads the picture once and draws it with a box on the field', async () => {
    const { mounted, calls } = await card(pageRequest({ pictured: true }));
    expect(shotCalls(calls)).toHaveLength(1);
    expect(shotCalls(calls)[0]?.init?.params).toEqual({ ferretId: 'hadi', requestId: REQUEST_ID });
    const figure = q<HTMLElement>(mounted.container, '[data-input-shot]');
    expect(q<HTMLImageElement>(figure, 'img').getAttribute('src')).toBe(`data:image/png;base64,${PNG}`);
    expect(figure.querySelectorAll('[data-input-shot-box]')).toHaveLength(1);
    expect(q<HTMLElement>(figure, '[data-input-shot-box="value"]').style.width).toBe('10%');
  });

  it('does not take the picture again when the same request is refreshed', async () => {
    const request = pageRequest({ pictured: true });
    const { mounted, calls, client } = await card(request);
    // A refresh brings the same request again (new facts, same id): the picture is not taken a second time.
    await mounted.render(
      <InputCard client={client} now={NOW} onDone={() => undefined} request={{ ...request, risk: undefined }} />,
    );
    await settle();
    expect(shotCalls(calls)).toHaveLength(1);
  });

  it('reads the new picture when the daemon rebinds the same request to a new observed digest', async () => {
    const request = pageRequest({ pictured: true });
    const NEW_PNG = `${PNG.slice(0, -4)}AAAA`;
    let answered = 0;
    const rig = recordingClient(async route => {
      if (route !== SHOT_ROUTE) return {};
      answered += 1;
      return answered === 1 ? SHOT : { ...SHOT, pngBase64: NEW_PNG };
    });
    const mounted = await mount(<InputCard client={rig.client} now={NOW} onDone={() => undefined} request={request} />);
    live.push(mounted);
    await settle();
    expect(q<HTMLImageElement>(mounted.container, '[data-input-shot] img').getAttribute('src')).toBe(
      `data:image/png;base64,${PNG}`,
    );
    // Same id, new picture, new facts, new digest: the card must not keep the old picture under the new boxes.
    await mounted.render(
      <InputCard
        client={rig.client}
        now={NOW}
        onDone={() => undefined}
        request={{ ...request, observedDigest: 'd'.repeat(64) }}
      />,
    );
    await settle();
    expect(shotCalls(rig.calls)).toHaveLength(2);
    expect(q<HTMLImageElement>(mounted.container, '[data-input-shot] img').getAttribute('src')).toBe(
      `data:image/png;base64,${NEW_PNG}`,
    );
  });

  it("draws the boxes without a hover title (the label is the ferret's wording)", async () => {
    const { mounted } = await card(pageRequest({ pictured: true }));
    expect(q<HTMLElement>(mounted.container, '[data-input-shot-box="value"]').hasAttribute('title')).toBe(false);
  });

  it('reads nothing for a card that is not pictured, or a terminal', async () => {
    const plain = await card(pageRequest());
    expect(shotCalls(plain.calls)).toHaveLength(0);
    expect(plain.mounted.container.querySelector('[data-input-shot]')).toBeNull();
    const terminal = await card(terminalRequest({ pictured: true }) as ReturnType<typeof pageRequest>);
    expect(shotCalls(terminal.calls)).toHaveLength(0);
    expect(terminal.mounted.container.querySelector('[data-input-shot]')).toBeNull();
  });

  it('draws nothing when the read is refused, and the card still works', async () => {
    const { mounted, calls } = await card(pageRequest({ pictured: true }), () => {
      throw new Error('not_found');
    });
    expect(shotCalls(calls)).toHaveLength(1);
    expect(mounted.container.querySelector('[data-input-shot]')).toBeNull();
    expect(q<HTMLButtonElement>(mounted.container, '[data-input-send]')).toBeDefined();
  });

  it('draws nothing for a picture that is not a PNG in base64', async () => {
    const { mounted } = await card(pageRequest({ pictured: true }), () => ({
      ...SHOT,
      pngBase64: '" onerror="alert(1)',
    }));
    expect(mounted.container.querySelector('[data-input-shot]')).toBeNull();
    expect(InputShotSchema.safeParse({ ...SHOT, pngBase64: 'a b' }).success).toBe(false);
    expect(InputShotSchema.safeParse({ ...SHOT, extra: 1 }).success).toBe(false);
  });

  it('drops the picture when the card unmounts', async () => {
    const { mounted } = await card(pageRequest({ pictured: true }));
    expect(mounted.container.querySelector('[data-input-shot]')).not.toBeNull();
    await mounted.unmount();
    expect(document.body.innerHTML).not.toContain(PNG);
  });
});
