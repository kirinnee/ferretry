import { beforeEach, describe, expect, it } from 'bun:test';
import { OwnedCatalogSchema } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogItemRow, type CatalogItemRowProps } from '../../../../src/features/catalogs/catalog-item-row.tsx';
import { type CatalogRowsHost, useCatalogRows } from '../../../../src/features/catalogs/catalog-row-tools.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { memberView } from '../../../support/catalog-sharing.ts';
import {
  CATALOG,
  DIGEST,
  INSTALL_ID,
  ITEM,
  installRecord,
  itemPreview,
  ownedCatalog,
} from '../../../support/catalog-views.ts';
import { healthOf } from '../../../support/health.ts';
import { byText, click, settle } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const SKILL = '/home/k/.claude/skills/pdf-tools/SKILL.md';
const source = { kind: 'skill', skill: SKILL } as const;
const scope = { label: 'User', title: 'A skill of yours', tone: 'muted' } as const;

type RowOverrides = Partial<Omit<CatalogItemRowProps, 'host' | 'read'>>;

function Row({ host, overrides }: { readonly host: CatalogRowsHost | undefined; readonly overrides?: RowOverrides }) {
  const read = useCatalogRows(host);
  return (
    <CatalogItemRow
      {...(host === undefined ? {} : { host, read })}
      kind="skill"
      itemName="pdf-tools"
      label="/pdf-tools"
      source={source}
      scope={scope}
      {...overrides}
    />
  );
}

const baseHandlers = (
  catalogs: ReturnType<typeof ownedCatalog>[],
  installs = [] as ReturnType<typeof installRecord>[],
) => ({
  'GET /v1/catalog-installs': () => ({ installs }),
  'GET /v1/catalogs': () => ({ catalogs }),
  'GET /v1/catalog-members': () => ({ members: [memberView()] }),
});

async function show(handlers: Parameters<typeof fakeClient>[0], overrides?: RowOverrides) {
  const fake = fakeClient(handlers);
  const view = await mount(<Row host={{ connection, createClient: fake.factory }} overrides={overrides} />);
  await settle();
  return { fake, view };
}

const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};
const pickMenu = async (label: string) => {
  await tap('[data-row-more]');
  await click(byText(document, '[role="menuitem"]', label));
  await settle();
};
const menu = (): (string | null)[] => [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent);

describe('CatalogItemRow rendering', () => {
  it('is the plain compact row without a host: name, scope, description and note, no buttons', async () => {
    const view = await mount(
      <Row
        host={undefined}
        overrides={{ description: 'Split and merge PDFs', note: 'Overridden by a Project skill', dimmed: true }}
      />,
    );
    expect(q('[data-row-scope]')?.textContent).toBe('User');
    expect(q('[data-row-scope]')?.getAttribute('title')).toBe('A skill of yours');
    expect(q('[data-row-description]')?.getAttribute('title')).toBe('Split and merge PDFs');
    expect(q('[data-row-note]')?.textContent).toContain('Overridden');
    expect(q('[data-row-use]')).toBeNull();
    expect(q('[data-row-controls]')).toBeNull();
    expect(q('[data-row-version]')).toBeNull();
    await view.unmount();
  });

  it('shows only the ⋯ with an Open item when there is no host but something to open', async () => {
    let opened = 0;
    const view = await mount(
      <Row host={undefined} overrides={{ onOpen: () => (opened += 1), openLabel: 'Show detail' }} />,
    );
    expect(q('[data-row-share]')).toBeNull();
    expect(q('[data-row-add]')).toBeNull();
    await tap('[data-row-more]');
    expect(q('[data-row-more]')?.getAttribute('aria-expanded')).toBe('true');
    await click(byText(document, '[role="menuitem"]', 'Show detail'));
    expect(opened).toBe(1);
    await view.unmount();
  });

  it('makes the name a button that uses the item, labelled for a screen reader', async () => {
    let used = 0;
    const view = await mount(<Row host={undefined} overrides={{ onUse: () => (used += 1) }} />);
    expect(q('[data-row-use]')?.getAttribute('aria-label')).toBe('Use /pdf-tools in chat');
    await click(q('[data-row-use]'));
    expect(used).toBe(1);
    await view.unmount();
  });

  it('an own skill in no catalog has no Share or Add on the row, and Publish in a catalog… in the ⋯', async () => {
    const { view } = await show(baseHandlers([]));
    expect(q('[data-row-share]')).toBeNull();
    expect(q('[data-row-add]')).toBeNull();
    expect(q('[data-row-more]')?.className).toContain('min-h-[44px]');
    expect(q('[data-row-version]')).toBeNull();
    expect(q('[data-row-from]')).toBeNull();
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Publish in a catalog…']);
    await view.unmount();
  });

  it('a skill in a catalog carries its version and Publish in another catalog…', async () => {
    const { view } = await show(baseHandlers([ownedCatalog()]));
    expect(q('[data-row-version]')?.textContent).toBe('v2');
    await tap('[data-row-more]');
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('More for /pdf-tools');
    expect(menu()).toEqual(['Publish in another catalog…']);
    await view.unmount();
  });

  it('an installed skill says where it came from and offers only Uninstall', async () => {
    const { view } = await show(baseHandlers([], [installRecord('skill', 'pdf-tools')]));
    expect(q('[data-row-from]')?.textContent).toMatch(/^from kirin-box · v\d+$/);
    expect(q('[data-row-from]')?.getAttribute('title')).toContain('From Team skills (kirin-box)');
    expect(q('[data-row-version]')).toBeNull();
    expect(q('[data-row-share]')).toBeNull();
    expect(q('[data-catalog-sheet]')).toBeNull();
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Uninstall']);
    await view.unmount();
  });

  it('never offers to publish what someone else’s catalog installed, even when a catalog here holds it', async () => {
    const { view } = await show(baseHandlers([ownedCatalog()], [installRecord('skill', 'pdf-tools')]));
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Uninstall']);
    await view.unmount();
  });

  it('has no Versions… or Share: they live in Sharing › My catalogs', async () => {
    const { view } = await show({
      ...baseHandlers([ownedCatalog()]),
      'GET /v1/health': () => healthOf('1.0.0', ['catalogs.items.1', 'catalogs.versions.1', 'catalogs.versions.2']),
    });
    await tap('[data-row-more]');
    expect(menu().join(' ')).not.toMatch(/Versions|Share/u);
    await view.unmount();
  });

  it('a server row matches its catalogs by server id and shows the content under the line', async () => {
    const withMcp = ownedCatalog(
      {},
      { kind: 'mcp', name: 'github', source: { kind: 'mcp', id: 'srv-1', name: 'github' } },
    );
    const fake = fakeClient(baseHandlers([withMcp]));
    const host = { connection, createClient: fake.factory };
    function McpRow() {
      const read = useCatalogRows(host);
      return (
        <CatalogItemRow
          host={host}
          read={read}
          kind="mcp"
          itemName="github"
          label="github"
          source={{ kind: 'mcp', mcp: 'srv-1' }}
          scope={scope}
        >
          <p data-under="">Connected</p>
        </CatalogItemRow>
      );
    }
    const view = await mount(<McpRow />);
    await settle();
    expect(q('[data-catalog-item-kind="mcp"] [data-row-version]')?.textContent).toBe('v2');
    expect(q('[data-under]')?.textContent).toBe('Connected');
    await view.unmount();
  });
});

describe('CatalogItemRow Publish', () => {
  it('Publish in a catalog… opens the add sheet, ends with Done, and reads the lists again when it saves', async () => {
    let catalogs = [] as ReturnType<typeof ownedCatalog>[];
    const { fake, view } = await show({
      ...baseHandlers([]),
      'GET /v1/catalogs': () => ({ catalogs }),
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview(),
      [`POST /v1/catalogs/${CATALOG}/items`]: () => {
        catalogs = [ownedCatalog()];
        return { itemId: ITEM, kind: 'skill', name: 'pdf-tools', itemVersion: 3, digest: DIGEST };
      },
    });
    catalogs = [ownedCatalog({ items: [] })];
    await pickMenu('Publish in a catalog…');
    expect(q('[data-catalog-sheet="add"]')).not.toBeNull();
    await tap('[data-catalog-preview]');
    await tap('[data-catalog-add]');
    expect(q('[data-catalog-landed]')).not.toBeNull();
    expect(q('[data-catalog-done]')?.textContent).toBe('Done');
    expect(fake.calls.filter(call => call.path === '/v1/catalog-installs').length).toBeGreaterThan(1);
    await tap('[data-catalog-done]');
    expect(q('[data-catalog-sheet="add"]')).toBeNull();
    expect(q('[data-row-version]')?.textContent).toBe('v2');
    await view.unmount();
  });

  it('Publish in another catalog… from the ⋯ opens the same sheet', async () => {
    const { view } = await show(baseHandlers([ownedCatalog()]));
    await pickMenu('Publish in another catalog…');
    expect(q('[data-catalog-sheet="add"]')).not.toBeNull();
    await view.unmount();
  });
});

describe('CatalogItemRow Uninstall', () => {
  const withInstall = (extra: Record<string, () => unknown> = {}) => ({
    ...baseHandlers([], [installRecord('skill', 'pdf-tools')]),
    ...extra,
  });

  it('asks first, can keep it, and uninstalls it then reads the lists again', async () => {
    let installs = [installRecord('skill', 'pdf-tools')];
    const { fake, view } = await show({
      ...baseHandlers([]),
      'GET /v1/catalog-installs': () => ({ installs }),
      [`DELETE /v1/catalog-installs/runtime/${INSTALL_ID}`]: () => {
        installs = [];
        return { installId: INSTALL_ID, removed: true };
      },
    });
    await pickMenu('Uninstall');
    expect(q('[data-catalog-remove-confirm]')?.textContent).toContain(
      'Uninstall pdf-tools from runtime box, profile default?',
    );
    expect(q('[data-catalog-remove-yes]')?.textContent).toBe('Uninstall it');
    await tap('[data-catalog-remove-no]');
    expect(q('[data-catalog-remove-confirm]')).toBeNull();
    await pickMenu('Uninstall');
    await tap('[data-catalog-remove-yes]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(q('[data-catalog-remove-confirm]')).toBeNull();
    expect(q('[data-row-from]')).toBeNull();
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Publish in a catalog…']);
    await view.unmount();
  });

  it('says why an uninstall was refused and keeps the row', async () => {
    const { view } = await show(
      withInstall({
        [`DELETE /v1/catalog-installs/runtime/${INSTALL_ID}`]: () => {
          throw new FyHttpError('edited', 409, 'catalog_install_conflict');
        },
      }),
    );
    await pickMenu('Uninstall');
    await tap('[data-catalog-remove-yes]');
    expect(q('[data-catalog-failure]')?.textContent).toContain('Nothing was changed');
    expect(q('[data-row-from]')).not.toBeNull();
    await tap('[data-catalog-remove-no]');
    await view.unmount();
  });

  it('names the catalog on each Uninstall when the item was installed from several', async () => {
    const second = { ...installRecord('skill', 'pdf-tools'), installId: `cin_${'j'.repeat(22)}` as const };
    const { view } = await show(baseHandlers([], [installRecord('skill', 'pdf-tools'), second]));
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Uninstall (from Team skills)', 'Uninstall (from Team skills)']);
    await view.unmount();
  });

  it('lists Open first and puts Uninstall after a separator', async () => {
    const { view } = await show(withInstall(), { onOpen: () => undefined });
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Open SKILL.md', 'Uninstall']);
    expect(q('[data-menu-separator]')).not.toBeNull();
    await view.unmount();
  });
});

describe('CatalogItemRow without a readable catalog list', () => {
  it('still offers Publish in a catalog… when the lists cannot be read', async () => {
    const { view } = await show({
      'GET /v1/catalog-installs': () => {
        throw new FyHttpError('boom', 500, 'x');
      },
      'GET /v1/catalogs': () => {
        throw new FyHttpError('boom', 500, 'x');
      },
    });
    await tap('[data-row-more]');
    expect(menu()).toEqual(['Publish in a catalog…']);
    await view.unmount();
  });

  it('a withdrawn item no longer counts as published', async () => {
    const withdrawn = OwnedCatalogSchema.parse({
      ...ownedCatalog(),
      items: ownedCatalog({}, { withdrawnAt: '2026-10-31T09:30:00.000Z' }).items,
    });
    const { view } = await show(baseHandlers([withdrawn]));
    expect(q('[data-row-version]')).toBeNull();
    await view.unmount();
  });
});
