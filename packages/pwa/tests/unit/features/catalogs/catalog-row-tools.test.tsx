import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  AddCatalogEntry,
  AddFromLinkLink,
  type CatalogRowsRead,
  useCatalogRows,
} from '../../../../src/features/catalogs/catalog-row-tools.tsx';
import { type AppStore, StoreProvider } from '../../../../src/lib/store.tsx';
import { RouterProvider } from '../../../../src/lib/router.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { installRecord, ownedCatalog } from '../../../support/catalog-views.ts';
import { chooseInstallFromFile } from '../../../support/catalog-add.ts';
import { click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

function Probe({
  host,
  seen,
}: {
  readonly host: Parameters<typeof useCatalogRows>[0];
  readonly seen: CatalogRowsRead[];
}) {
  const read = useCatalogRows(host);
  seen.push(read);
  return (
    <button type="button" data-reload="" onClick={read.reload}>
      {read.installs.length} installs, {read.catalogs.length} catalogs
    </button>
  );
}

describe('useCatalogRows', () => {
  it('reads the installs and the catalogs, and reads them again on reload', async () => {
    let installs = [installRecord('skill', 'pdf-tools')];
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs }),
      'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    });
    const seen: CatalogRowsRead[] = [];
    const view = await mount(<Probe host={{ connection, createClient: fake.factory }} seen={seen} />);
    await settle();
    expect(q('[data-reload]')?.textContent).toBe('1 installs, 1 catalogs');
    installs = [];
    await click(q('[data-reload]'));
    await settle();
    expect(q('[data-reload]')?.textContent).toBe('0 installs, 1 catalogs');
    await view.unmount();
  });

  it('keeps each list on its own when the other cannot be read', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => {
        throw new FyHttpError('boom', 500, 'x');
      },
      'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    });
    const view = await mount(<Probe host={{ connection, createClient: fake.factory }} seen={[]} />);
    await settle();
    expect(q('[data-reload]')?.textContent).toBe('0 installs, 1 catalogs');
    await view.unmount();
    const second = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs: [installRecord('skill', 'pdf-tools')] }),
      'GET /v1/catalogs': () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    const other = await mount(<Probe host={{ connection, createClient: second.factory }} seen={[]} />);
    await settle();
    expect(q('[data-reload]')?.textContent).toBe('1 installs, 0 catalogs');
    await other.unmount();
  });

  it('reads nothing without a host', async () => {
    const view = await mount(<Probe host={undefined} seen={[]} />);
    await settle();
    expect(q('[data-reload]')?.textContent).toBe('0 installs, 0 catalogs');
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

describe('AddFromLinkLink', () => {
  afterEach(() => {
    mock.restore();
  });

  it('opens Sharing › Shared with me through the router', async () => {
    const pushed: string[] = [];
    const state: { current: unknown } = { current: null };
    const browser = Object.assign(new EventTarget(), {
      history: {
        get state() {
          return state.current;
        },
        pushState: (next: unknown, _title: string, url?: string | URL | null) => {
          state.current = next;
          pushed.push(String(url));
        },
        replaceState: (next: unknown) => {
          state.current = next;
        },
        back: () => {},
      },
      location: { pathname: '/', search: '' },
    });
    const view = await mount(
      <RouterProvider browser={browser as unknown as Window} trailStorage={null}>
        <AddFromLinkLink host={{ connection }} />
      </RouterProvider>,
    );
    expect(q('[data-catalog-add-link]')?.textContent).toBe('Add from a link…');
    await click(q('[data-catalog-add-link]'));
    expect(pushed).toEqual(['/d/alpha/sharing/shared']);
    await view.unmount();
  });

  it('follows the address bar where there is no router', async () => {
    const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
    const view = await mount(<AddFromLinkLink host={{ connection }} />);
    await click(q('[data-catalog-add-link]'));
    expect(assign).toHaveBeenCalledWith('/d/alpha/sharing/shared');
    await view.unmount();
  });
});
