import { beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogsSurface } from '../../../../src/features/catalogs/catalogs-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { CATALOG, ownedCatalog } from '../../../support/catalog-views.ts';
import { byText, click, settle } from '../../../support/dom-form.ts';
import { healthOf } from '../../../support/health.ts';
import { mount } from '../../../support/dom.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const SECOND = `cat_${'d'.repeat(22)}` as const;
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const others = ownedCatalog({ id: SECOND, name: 'Other' });

async function open(options: { features: string[]; list?: Record<string, unknown>; patch?: () => unknown }) {
  let defaultId: string = CATALOG;
  const list = () => ({ catalogs: [ownedCatalog(), others], defaultCatalogId: defaultId, ...options.list });
  const fake = fakeClient({
    'GET /v1/catalogs': list,
    'GET /v1/catalogs?sourceState=1': list,
    'GET /v1/health': () => healthOf('1.0.0', options.features),
    [`PATCH /v1/catalogs/${SECOND}`]:
      options.patch ??
      (() => {
        defaultId = SECOND;
        return ownedCatalog({ id: SECOND, name: 'Other', role: 'default' });
      }),
  });
  const view = await mount(
    <CatalogsSurface
      connection={connection}
      createClient={fake.factory}
      installHost={{ createClient: fake.factory, projects: [] }}
    />,
  );
  await settle();
  return { fake, view };
}

const openCatalog = async (name: string): Promise<void> => {
  await click(q(`[data-catalog-open="${name}"]`));
  await settle();
};

describe('the default catalog in My catalogs', () => {
  it('marks only the default, in the list and in its own page', async () => {
    const { view } = await open({ features: ['catalogs.items.1'] });
    expect(q(`[data-catalog-open="Team skills"] [data-catalog-default]`)?.textContent).toBe('default');
    expect(q(`[data-catalog-open="Other"] [data-catalog-default]`)).toBeNull();
    await openCatalog('Team skills');
    expect(q('[data-catalog-detail] [data-catalog-default]')).not.toBeNull();
    expect(q('[data-catalog-more-menu]')).toBeNull();
    await view.unmount();
  });

  it('makes another catalog the default from its ⋯ and says so', async () => {
    const { fake, view } = await open({ features: ['catalogs.items.1'] });
    await openCatalog('Other');
    expect(q('[data-catalog-more-menu]')?.getAttribute('aria-label')).toBe('More for Other');
    await click(q('[data-catalog-more-menu]'));
    await click(byText(document, '[role="menuitem"]', 'Make default'));
    await settle();
    expect(fake.calls.find(call => call.method === 'PATCH')?.body).toEqual({ role: 'default' });
    expect(q('[data-catalog-detail]')?.textContent).toContain('Other is now the default catalog.');
    expect(q('[data-catalog-detail] [data-catalog-default]')).not.toBeNull();
    expect(q('[data-catalog-more-menu]')).toBeNull();
    await view.unmount();
  });

  it('says why it could not', async () => {
    const { view } = await open({
      features: ['catalogs.items.1'],
      patch: () => {
        throw new FyHttpError('no', 409, 'items_full');
      },
    });
    await openCatalog('Other');
    await click(q('[data-catalog-more-menu]'));
    await click(byText(document, '[role="menuitem"]', 'Make default'));
    await settle();
    expect(q('[data-catalog-detail]')?.textContent).toContain('shared items');
    expect(q('[data-catalog-detail]')?.textContent).not.toContain('is now the default');
    await view.unmount();
  });

  it('offers nothing to a machine from before the item table', async () => {
    const { view } = await open({ features: [], list: { defaultCatalogId: undefined } });
    await openCatalog('Other');
    expect(q('[data-catalog-more-menu]')).toBeNull();
    await view.unmount();
  });

  it('marks a catalog by its role when the list names no id', async () => {
    const { view } = await open({
      features: ['catalogs.items.1'],
      list: { defaultCatalogId: undefined, catalogs: [ownedCatalog({ role: 'default' }), others] },
    });
    expect(q(`[data-catalog-open="Team skills"] [data-catalog-default]`)).not.toBeNull();
    await view.unmount();
  });
});
