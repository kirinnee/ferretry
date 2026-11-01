import { beforeEach, describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { CatalogsSurface } from '../../../../src/features/catalogs/catalogs-surface.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { CATALOG, DIGEST, ITEM, itemPreview, ownedCatalog } from '../../../support/catalog-views.ts';
import { chooseInstallFromFile } from '../../../support/catalog-add.ts';
import { click, settle, typeInto } from '../../../support/dom-form.ts';
import { mount } from '../../../support/dom.ts';

/** Earlier files in the same run can leave screens behind, and the queries here read the whole document. */
beforeEach(() => {
  document.body.replaceChildren();
});

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });
const AT = '2026-10-31T09:00:00.000Z';
const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const MCP_ITEM = `itm_${'m'.repeat(22)}`;
const OLD_ITEM = `itm_${'o'.repeat(22)}`;
const DETAIL = '/v1/catalogs?sourceState=1';

const version = { version: 1, digest: DIGEST, size: 2048, publishedAt: AT };
const rich = (state: Record<string, unknown> = {}) =>
  ownedCatalog({
    description: 'Shared with the team.',
    items: [
      {
        itemId: ITEM,
        kind: 'skill',
        name: 'pdf-tools',
        summary: 'Split PDFs',
        source: { kind: 'skill', path: '/home/k/.claude/skills/pdf-tools/SKILL.md' },
        versions: [version],
        sourceState: 'changed',
        ...state,
      },
      {
        itemId: MCP_ITEM,
        kind: 'mcp',
        name: 'acme-mcp',
        summary: 'Acme',
        source: { kind: 'mcp', id: 'acme', name: 'acme' },
        versions: [version],
        sourceState: 'unavailable',
        sourceNote: 'The server is not set up here.',
      },
      {
        itemId: OLD_ITEM,
        kind: 'skill',
        name: 'old-one',
        summary: 'Gone',
        source: { kind: 'skill', path: '/x/SKILL.md' },
        versions: [version],
        withdrawnAt: AT,
      },
    ],
  });

async function open(handlers: Parameters<typeof fakeClient>[0], extra: Record<string, unknown> = {}) {
  const fake = fakeClient(handlers);
  const saved: Array<{ name: string; text: string }> = [];
  const view = await mount(
    <CatalogsSurface
      connection={connection}
      createClient={fake.factory}
      saveFile={(name, text) => saved.push({ name, text })}
      installHost={{ createClient: fake.factory, projects: [] }}
      {...extra}
    />,
  );
  await settle();
  return { fake, view, saved };
}

const tap = async (selector: string) => {
  await click(q(selector));
  await settle();
};

describe('CatalogsSurface list', () => {
  it('says there are none yet', async () => {
    const { view } = await open({ 'GET /v1/catalogs': () => ({ catalogs: [] }) });
    expect(q('[data-catalogs-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('lists catalogs with counts and does not ask for source state', async () => {
    const { fake, view } = await open({ 'GET /v1/catalogs': () => ({ catalogs: [rich()] }) });
    expect(q('[data-catalogs-list]')?.textContent).toContain('Team skills');
    expect(q('[data-catalogs-list]')?.textContent).toContain('2 items · revision 4');
    expect(fake.calls.map(call => call.path)).toEqual(['/v1/catalogs', '/v1/health']);
    await view.unmount();
  });

  it('says Sharing is off, with no failing buttons', async () => {
    const { view } = await open({
      'GET /v1/catalogs': () => {
        throw new FyHttpError('no', 403, 'grant_device_not_granted');
      },
    });
    expect(q('[data-sharing-off]')).not.toBeNull();
    expect(q('[data-catalog-more]')).toBeNull();
    expect(q('[data-catalog-link-input]')).not.toBeNull();
    await view.unmount();
  });

  it('shows another failure and reads again on Try again', async () => {
    let broken = true;
    const { view } = await open({
      'GET /v1/catalogs': () => {
        if (broken) throw new FyHttpError('boom', 500, 'x');
        return { catalogs: [] };
      },
    });
    expect(q('[data-catalog-failure]')).not.toBeNull();
    broken = false;
    await tap('[data-catalog-preview-again]');
    expect(q('[data-catalogs-empty]')).not.toBeNull();
    await view.unmount();
  });

  it('opens the install sheet', async () => {
    const { view } = await open({ 'GET /v1/catalogs': () => ({ catalogs: [] }) });
    await chooseInstallFromFile();
    expect(q('[data-catalog-sheet]')).not.toBeNull();
    await view.unmount();
  });
});

describe('CatalogsSurface detail', () => {
  const both = (change: Parameters<typeof fakeClient>[0] = {}) => ({
    'GET /v1/catalogs': () => ({ catalogs: [rich()] }),
    [`GET ${DETAIL}`]: () => ({ catalogs: [rich()] }),
    ...change,
  });

  it('shows items with versions and states, and goes back', async () => {
    const { fake, view } = await open(both());
    await tap('[data-catalog-open]');
    expect(fake.calls.some(call => call.path === DETAIL)).toBe(true);
    const detail = q('[data-catalog-detail]')?.textContent ?? '';
    expect(detail).toContain('Shared with the team.');
    expect(detail).toContain('signed as kirin-box');
    expect(detail).toContain('Source changed');
    expect(detail).toContain('Source not found: The server is not set up here.');
    expect(detail).toContain('Withdrawn');
    expect(q('[data-catalog-version]')?.textContent).toContain('Version 1');
    expect(q('[data-catalog-withdraw="old-one"]')).toBeNull();
    await tap('[data-catalog-back]');
    expect(q('[data-catalogs-list]')).not.toBeNull();
    await view.unmount();
  });

  it('says a catalog is gone when it vanished, and goes back', async () => {
    let gone = false;
    const { view } = await open(
      both({
        [`GET ${DETAIL}`]: () => ({ catalogs: gone ? [] : [rich()] }),
        [`PATCH /v1/catalogs/${CATALOG}`]: () => {
          gone = true;
          return ownedCatalog();
        },
      }),
    );
    await tap('[data-catalog-open]');
    await tap('[data-catalog-rename]');
    await typeInto(q('[data-catalog-rename-form] input'), 'Other');
    await tap('[data-catalog-rename-save]');
    expect(q('[data-catalog-gone]')).not.toBeNull();
    await click(q('[data-catalog-gone] button'));
    expect(q('[data-catalogs-list]')).not.toBeNull();
    await view.unmount();
  });

  it('exports the signed file and names it', async () => {
    const file = { shape: 'signed' };
    const { saved, view } = await open(both({ [`POST /v1/catalogs/${CATALOG}/export`]: () => file }));
    await tap('[data-catalog-open]');
    await tap('[data-catalog-export]');
    expect(saved).toEqual([{ name: 'Team-skills.catalog.json', text: JSON.stringify(file) }]);
    expect(q('[data-catalog-note]')?.textContent).toContain('Saved Team-skills.catalog.json.');
    await view.unmount();
  });

  it('shows a failed export in words', async () => {
    const { view } = await open(
      both({
        [`POST /v1/catalogs/${CATALOG}/export`]: () => {
          throw new FyHttpError('boom', 500, 'x');
        },
      }),
    );
    await tap('[data-catalog-open]');
    await tap('[data-catalog-export]');
    expect(q('[data-catalog-failure]')).not.toBeNull();
    await view.unmount();
  });

  it('shows Sharing off if a write is refused for the grant', async () => {
    const { view } = await open(
      both({
        [`POST /v1/catalogs/${CATALOG}/export`]: () => {
          throw new FyHttpError('no', 403, 'grant_device_not_granted');
        },
      }),
    );
    await tap('[data-catalog-open]');
    await tap('[data-catalog-export]');
    expect(q('[data-sharing-off]')).not.toBeNull();
    await view.unmount();
  });

  it('renames only what changed, and can cancel', async () => {
    const { fake, view } = await open(
      both({ [`PATCH /v1/catalogs/${CATALOG}`]: () => ownedCatalog({ name: 'Better' }) }),
    );
    await tap('[data-catalog-open]');
    await tap('[data-catalog-rename]');
    expect(q('[data-catalog-rename-save]')?.hasAttribute('disabled')).toBe(true);
    await click([...document.querySelectorAll('[data-catalog-rename-form] button')].at(-1) ?? null);
    expect(q('[data-catalog-rename-form]')).toBeNull();
    await tap('[data-catalog-rename]');
    await typeInto(q('[data-catalog-rename-form] input'), ' Better ');
    await tap('[data-catalog-rename-save]');
    expect(fake.calls.find(call => call.method === 'PATCH')?.body).toEqual({ name: 'Better' });
    expect(q('[data-catalog-rename-form]')).toBeNull();
    await view.unmount();
  });

  it('changes the description alone', async () => {
    const { fake, view } = await open(both({ [`PATCH /v1/catalogs/${CATALOG}`]: () => ownedCatalog() }));
    await tap('[data-catalog-open]');
    await tap('[data-catalog-rename]');
    const area = q('[data-catalog-rename-form] textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(area, 'New words');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await tap('[data-catalog-rename-save]');
    expect(fake.calls.find(call => call.method === 'PATCH')?.body).toEqual({ description: 'New words' });
    await view.unmount();
  });

  it('asks before withdrawing, and can keep the item', async () => {
    const { fake, view } = await open(
      both({ [`DELETE /v1/catalogs/${CATALOG}/items/${MCP_ITEM}`]: () => ({ itemId: MCP_ITEM }) }),
    );
    await tap('[data-catalog-open]');
    await tap('[data-catalog-withdraw="acme-mcp"]');
    expect(document.body.textContent).toContain('Withdraw acme-mcp?');
    const keep = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button')].find(
      b => b.textContent === 'Keep it',
    );
    await click(keep ?? null);
    expect(q('[data-catalog-withdraw-yes]')).toBeNull();
    await tap('[data-catalog-withdraw="acme-mcp"]');
    await tap('[data-catalog-withdraw-yes]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    await view.unmount();
  });

  it('asks in words before deleting, and can keep the catalog', async () => {
    const { fake, view } = await open(both({ [`DELETE /v1/catalogs/${CATALOG}`]: () => ({ catalogId: CATALOG }) }));
    await tap('[data-catalog-open]');
    await tap('[data-catalog-delete]');
    expect(q('[data-catalog-delete-confirm]')?.textContent).toContain('This cannot be undone.');
    const keep = [...document.querySelectorAll<HTMLElement>('[data-catalog-delete-confirm] button')].find(
      b => b.textContent === 'Keep it',
    );
    await click(keep ?? null);
    expect(q('[data-catalog-delete-confirm]')).toBeNull();
    await tap('[data-catalog-delete]');
    await tap('[data-catalog-delete-yes]');
    expect(fake.calls.some(call => call.method === 'DELETE')).toBe(true);
    expect(q('[data-catalogs-list]')).not.toBeNull();
    await view.unmount();
  });

  it('publishes an update for a changed source through the preview', async () => {
    const { fake, view } = await open(
      both({
        [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview({ version: 2 }),
        [`POST /v1/catalogs/${CATALOG}/items/${ITEM}/versions`]: () => ({
          itemId: ITEM,
          kind: 'skill',
          name: 'pdf-tools',
          itemVersion: 2,
          digest: DIGEST,
        }),
      }),
    );
    await tap('[data-catalog-open]');
    expect(document.body.textContent).toContain('freezes a new version');
    await tap('[data-catalog-publish="pdf-tools"]');
    await tap('[data-catalog-preview]');
    expect(fake.calls.at(-1)?.body).toEqual({ itemId: ITEM });
    await tap('[data-catalog-add]');
    expect(q('[data-catalog-landed]')?.textContent).toContain('version 2');
    await tap('[data-catalog-done]');
    expect(q('[data-catalog-sheet]')).toBeNull();
    await view.unmount();
  });

  it('leaves people and codes to the Sharing page: the list carries no People button', async () => {
    const { view } = await open(
      both({ 'GET /v1/catalog-members': () => ({ members: [] }), 'GET /v1/catalog-shares': () => ({ shares: [] }) }),
    );
    expect(q('[data-catalogs-list]')).not.toBeNull();
    expect(q('[data-catalogs-people]')).toBeNull();
    await view.unmount();
  });

  it('opens the share sheet from a catalog and closes it', async () => {
    const { view } = await open(both({ 'GET /v1/catalog-members': () => ({ members: [] }) }));
    await tap('[data-catalog-open]');
    await tap('[data-catalog-share]');
    expect(q('[data-catalog-sheet="share"]')).not.toBeNull();
    await tap('[aria-label="Close the share sheet"]');
    expect(q('[data-catalog-sheet="share"]')).toBeNull();
    await view.unmount();
  });

  it('publishes an update for an MCP item', async () => {
    const changed = (state: string) =>
      rich({ sourceState: 'unchanged' }).items.map(item =>
        item.kind === 'mcp' ? { ...item, sourceState: state } : item,
      );
    const both2 = ownedCatalog({ items: changed('changed') });
    const { fake, view } = await open({
      'GET /v1/catalogs': () => ({ catalogs: [both2] }),
      [`GET ${DETAIL}`]: () => ({ catalogs: [both2] }),
      [`POST /v1/catalogs/${CATALOG}/items/preview`]: () => itemPreview(),
    });
    await tap('[data-catalog-open]');
    expect(q('[data-catalog-publish="pdf-tools"]')).toBeNull();
    await tap('[data-catalog-publish="acme-mcp"]');
    await tap('[data-catalog-preview]');
    expect(fake.calls.at(-1)?.body).toEqual({ itemId: MCP_ITEM });
    await view.unmount();
  });
});
