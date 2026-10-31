import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { AddToCatalogSheet } from '../../../../src/features/catalogs/add-to-catalog-sheet.tsx';
import { FailureLine, SharingOffPanel } from '../../../../src/features/catalogs/catalog-parts.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { CATALOG, DIGEST, ITEM, itemPreview, ownedCatalog } from '../../../support/catalog-views.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const source = { kind: 'skill', skill: '/home/k/.claude/skills/pdf-tools/SKILL.md' } as const;
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const published = { itemId: ITEM, kind: 'skill', name: 'pdf-tools', itemVersion: 3, digest: DIGEST };
const list =
  (...catalogs: ReturnType<typeof ownedCatalog>[]) =>
  () => ({ catalogs });

async function open(handlers: Parameters<typeof fakeClient>[0], extra: Record<string, unknown> = {}) {
  const fake = fakeClient(handlers);
  const closed: string[] = [];
  const view = await mount(
    <AddToCatalogSheet
      connection={connection}
      source={source}
      label="pdf-tools"
      createClient={fake.factory}
      onClose={() => closed.push('closed')}
      {...extra}
    />,
  );
  await settle();
  return { fake, view, closed };
}

describe('parts', () => {
  it('says Sharing is off with the one command', async () => {
    const view = await mount(<SharingOffPanel />);
    expect(view.container.querySelector('[data-sharing-off]')?.textContent).toContain('fy device grant');
    await view.unmount();
  });

  it('puts this device’s own id in the command', async () => {
    const id = `fy_device_id_${'b'.repeat(22)}`;
    const fake = fakeClient({ 'GET /v1/pair/devices': () => ({ devices: [], hostLocal: false, thisDeviceId: id }) });
    const view = await mount(<SharingOffPanel connection={connection} createClient={fake.factory} />);
    await settle();
    expect(view.container.querySelector('[data-sharing-off]')?.textContent).toContain(
      `fy device grant ${id} sharing --use`,
    );
    await view.unmount();
  });

  it('keeps the placeholder when the device cannot be read', async () => {
    const fake = fakeClient({});
    const view = await mount(<SharingOffPanel connection={connection} createClient={fake.factory} />);
    await settle();
    expect(view.container.querySelector('[data-sharing-off]')?.textContent).toContain('<device>');
    await view.unmount();
  });

  it('shows a failure with no button unless one is asked for', async () => {
    const view = await mount(<FailureLine sentence="Nope." />);
    expect(view.container.textContent).toContain('Nope.');
    expect(view.container.querySelector('[data-catalog-preview-again]')).toBeNull();
    await view.unmount();
    let again = 0;
    const second = await mount(<FailureLine sentence="Nope." again onAgain={() => (again += 1)} />);
    await click(second.container.querySelector('[data-catalog-preview-again]'));
    expect(again).toBe(1);
    await second.unmount();
  });
});

describe('AddToCatalogSheet', () => {
  it('previews into the chosen catalog, shows what is frozen, and adds bound to the previewed digest', async () => {
    const preview = itemPreview({
      warnings: [{ code: 'carries-scripts', text: 'It carries a script.' }],
      problems: [{ subject: 'big.bin', reason: 'Too large.' }],
    });
    const { fake, view, closed } = await open({
      'GET /v1/catalogs': list(ownedCatalog()),
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => preview,
      [`POST /v1/catalogs/${CATALOG}/items`]: () => published,
    });
    expect(q('[data-catalog-add]')).toBeNull();
    await click(q('[data-catalog-preview]'));
    const body = q('[data-catalog-preview-block]');
    expect(body?.textContent).toContain('Read from /home/k/.claude/skills/pdf-tools/SKILL.md');
    expect(body?.textContent).toContain('It carries a script.');
    expect(body?.textContent).toContain('big.bin');
    expect(body?.textContent).toContain('# pdf tools');
    expect(document.body.textContent).toContain('A frozen copy is shared.');
    await click(q('[data-catalog-add]'));
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/v1/catalogs/${CATALOG}/items`,
      body: { source, digest: DIGEST },
    });
    expect(q('[data-catalog-landed]')?.textContent).toContain('Saved to Team skills as version 3.');
    await click(q('[data-catalog-done]'));
    expect(closed).toEqual(['closed']);
    await view.unmount();
  });

  it('offers Preview again when the source changed since it was previewed', async () => {
    let previews = 0;
    const { view } = await open({
      'GET /v1/catalogs': list(ownedCatalog()),
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => {
        previews += 1;
        return itemPreview();
      },
      [`POST /v1/catalogs/${CATALOG}/items`]: () => {
        throw new FyHttpError('changed', 409, 'changed_since_preview');
      },
    });
    await click(q('[data-catalog-preview]'));
    await click(q('[data-catalog-add]'));
    expect(q('[data-catalog-failure]')).not.toBeNull();
    await click(q('[data-catalog-preview-again]'));
    expect(previews).toBe(2);
    await view.unmount();
  });

  it('says Sharing is off instead of showing buttons that fail', async () => {
    const { view } = await open({
      'GET /v1/catalogs': () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    expect(q('[data-catalog-preview]')).toBeNull();
    await view.unmount();
  });

  it('shows another failure on reading the catalogs and can try again', async () => {
    let broken = true;
    const { view } = await open({
      'GET /v1/catalogs': () => {
        if (broken) throw new FyHttpError('boom', 500, 'x');
        return { catalogs: [] };
      },
    });
    expect(q('[data-catalog-failure]')).not.toBeNull();
    broken = false;
    await click(q('[data-catalog-preview-again]'));
    await settle();
    expect(q('[data-catalog-new-name]')).not.toBeNull();
    await view.unmount();
  });

  it('names the first catalog, makes it, previews into it and keeps it chosen', async () => {
    let made = false;
    const { fake, view } = await open({
      'GET /v1/catalogs': () => ({ catalogs: made ? [ownedCatalog()] : [] }),
      'POST /v1/catalogs': () => {
        made = true;
        return ownedCatalog();
      },
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview(),
    });
    expect(document.body.textContent).toContain('You have no catalog yet.');
    expect(q('[data-catalog-preview]')?.hasAttribute('disabled')).toBe(true);
    await typeInto(q('[data-catalog-new-name]'), 'Team skills');
    await click(q('[data-catalog-preview]'));
    expect(fake.calls.map(call => `${call.method} ${call.path}`)).toContain('POST /v1/catalogs');
    expect(q('[data-catalog-preview-block]')).not.toBeNull();
    expect(q('[data-catalog-picker]')).not.toBeNull();
    await view.unmount();
  });

  it('creates a new catalog only on Add when an existing one was open to preview against', async () => {
    const second = ownedCatalog({ id: `cat_${'d'.repeat(22)}`, name: 'Fresh' });
    const { fake, view } = await open({
      'GET /v1/catalogs': list(ownedCatalog()),
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview(),
      'POST /v1/catalogs': () => second,
      [`POST /v1/catalogs/${second.id}/items`]: () => published,
    });
    const picker = q('[data-catalog-picker]') as HTMLSelectElement;
    picker.value = '__new';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await typeInto(q('[data-catalog-new-name]'), 'Fresh');
    await click(q('[data-catalog-preview]'));
    await click(q('[data-catalog-add]'));
    expect(fake.calls.some(call => call.path === `/v1/catalogs/${second.id}/items`)).toBe(true);
    expect(q('[data-catalog-landed]')?.textContent).toContain('Saved to Fresh');
    await view.unmount();
  });

  it('publishes an update to an item through the same preview', async () => {
    const { fake, view } = await open(
      {
        'GET /v1/catalogs': list(ownedCatalog()),
        [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview({ version: 3 }),
        [`POST /v1/catalogs/${CATALOG}/items/${ITEM}/versions`]: () => published,
      },
      { publish: { catalogId: CATALOG, itemId: ITEM } },
    );
    expect(q('[data-catalog-picker]')).toBeNull();
    await click(q('[data-catalog-preview]'));
    expect(fake.calls.at(-1)?.body).toEqual({ itemId: ITEM });
    await click(q('[data-catalog-add]'));
    expect(fake.calls.at(-1)).toMatchObject({ body: { digest: DIGEST } });
    expect(q('[data-catalog-landed]')?.textContent).toContain('version 3');
    await view.unmount();
  });
});
