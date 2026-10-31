import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  CatalogRowTools,
  type CatalogRowsHost,
  AddCatalogEntry,
  useCatalogInstalls,
} from '../../../../src/features/catalogs/catalog-row-tools.tsx';
import { type AppStore, StoreProvider } from '../../../../src/lib/store.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { INSTALL_ID, installRecord, ownedCatalog } from '../../../support/catalog-views.ts';
import { chooseInstallFromFile } from '../../../support/catalog-add.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const source = { kind: 'skill', skill: '/home/k/.claude/skills/pdf-tools/SKILL.md' } as const;

function Row({ host, name = 'pdf-tools' }: { readonly host: CatalogRowsHost; readonly name?: string }) {
  const read = useCatalogInstalls(host);
  return <CatalogRowTools host={host} kind="skill" name={name} source={source} read={read} />;
}

const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};

describe('CatalogRowTools', () => {
  it('shows where an installed item came from and offers Add to catalog', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({
        installs: [installRecord('skill', 'pdf-tools'), installRecord('mcp', 'pdf-tools')],
      }),
      'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    });
    const host = { connection, createClient: fake.factory };
    const view = await mount(<Row host={host} />);
    await settle();
    expect(document.querySelectorAll('[data-catalog-installed-from]').length).toBe(1);
    expect(q('[data-catalog-installed-from]')?.textContent).toContain('From Team skills (kirin-box)');
    await tap('[data-catalog-add-to]');
    expect(q('[data-catalog-sheet="add"]')).not.toBeNull();
    await tap('button[aria-label^="Close"]');
    expect(q('[data-catalog-sheet="add"]')).toBeNull();
    await view.unmount();
  });

  it('shows no provenance for an item no catalog wrote', async () => {
    const fake = fakeClient({ 'GET /v1/catalog-installs': () => ({ installs: [] }) });
    const view = await mount(<Row host={{ connection, createClient: fake.factory }} name="other" />);
    await settle();
    expect(q('[data-catalog-installed-from]')).toBeNull();
    expect(q('[data-catalog-add-to="other"]')).not.toBeNull();
    await view.unmount();
  });

  it('shows nothing extra when the installs cannot be read', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => {
        throw new FyHttpError('boom', 500, 'x');
      },
    });
    const view = await mount(<Row host={{ connection, createClient: fake.factory }} />);
    await settle();
    expect(q('[data-catalog-installed-from]')).toBeNull();
    expect(q('[data-catalog-add-to]')).not.toBeNull();
    await view.unmount();
  });

  it('asks before removing, can keep it, and removes it then reads again', async () => {
    let installs = [installRecord('skill', 'pdf-tools')];
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs }),
      [`DELETE /v1/catalog-installs/runtime/${INSTALL_ID}`]: () => {
        installs = [];
        return { installId: INSTALL_ID, removed: true };
      },
    });
    const view = await mount(<Row host={{ connection, createClient: fake.factory }} />);
    await settle();
    await tap('[data-catalog-remove]');
    expect(q('[data-catalog-remove-confirm]')?.textContent).toContain(
      'Remove pdf-tools from runtime box, profile default?',
    );
    expect(q('[data-catalog-remove]')).toBeNull();
    await tap('[data-catalog-remove-no]');
    expect(q('[data-catalog-remove-confirm]')).toBeNull();
    await tap('[data-catalog-remove]');
    await tap('[data-catalog-remove-yes]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(q('[data-catalog-installed-from]')).toBeNull();
    await view.unmount();
  });

  it('says why a removal was refused and keeps the row', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs: [installRecord('skill', 'pdf-tools')] }),
      [`DELETE /v1/catalog-installs/runtime/${INSTALL_ID}`]: () => {
        throw new FyHttpError('edited', 409, 'catalog_install_conflict');
      },
    });
    const view = await mount(<Row host={{ connection, createClient: fake.factory }} />);
    await settle();
    await tap('[data-catalog-remove]');
    await tap('[data-catalog-remove-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Nothing was changed');
    expect(q('[data-catalog-installed-from]')).not.toBeNull();
    await tap('[data-catalog-remove-no]');
    await view.unmount();
  });
});

describe('AddCatalogEntry', () => {
  it('opens and closes the install sheet', async () => {
    const fake = fakeClient({});
    const store = {
      projects: { subscribe: () => () => undefined, slice: () => 1, projects: () => [] },
    } as unknown as AppStore;
    const view = await mount(
      <StoreProvider store={store}>
        <AddCatalogEntry host={{ connection, createClient: fake.factory }} />
      </StoreProvider>,
    );
    await chooseInstallFromFile();
    expect(q('[data-catalog-sheet="install"]')).not.toBeNull();
    await view.unmount();
  });
});
