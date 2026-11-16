import { describe, expect, it } from 'bun:test';
import { interact, mount, noteClientDaemon, settleUntil } from '@ferretry/app/testing';
import { MCP_INSTALL_SLOT, MCP_ROW_SLOT } from '@ferretry/plugin-mcp/contract';
import { type FunctionComponent, Suspense } from 'react';
import half from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { byText, click, settle } from '../support/dom-form.ts';
import { installRecord } from '../support/catalog-views.ts';

type Answers = Readonly<Record<string, (init: unknown) => unknown>>;

const serverProps = (name: string, extra: Record<string, unknown> = {}) => ({
  subject: 'f1',
  ferret: 'f1',
  id: `id-${name}-project`,
  name,
  scope: 'project',
  ...extra,
});

/** The half's `mcp-row` and `mcp-install` panels on a client that answers by route key and counts every call. */
function panelsOn(answers: Answers, daemon: string | null = 'alpha') {
  const calls: { readonly key: string; readonly init: unknown }[] = [];
  const client = {
    call: async (key: string, init?: unknown) => {
      calls.push({ key, init });
      const answer = answers[key];
      if (answer === undefined) throw new Error(`unexpected call ${key}`);
      return answer(init);
    },
  } as never;
  if (daemon !== null) noteClientDaemon(client, daemon);
  const built = half.build?.({ manifest: half.manifest, client });
  const Row = built?.panels?.['mcp-row'] as unknown as FunctionComponent<Record<string, unknown>>;
  const Install = built?.panels?.['mcp-install'] as unknown as FunctionComponent<Record<string, unknown>>;
  return { Row, Install, calls };
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const rowOf = (name: string): HTMLElement => {
  const row = q(`[data-catalog-item-row="${name}"]`);
  if (row === null) throw new Error(`no catalog row for ${name}`);
  return row;
};
const menuLabels = (): (string | null)[] => [...document.querySelectorAll('[role="menuitem"]')].map(n => n.textContent);
const openMenuOf = async (name: string): Promise<void> => {
  await click(rowOf(name).querySelector('[data-row-more]'));
  await settle();
};

const withInstall = (installs: ReturnType<typeof installRecord>[]): Answers => ({
  'GET /v1/catalog-installs': () => ({ installs }),
  'GET /v1/catalogs': () => ({ catalogs: [] }),
});

describe('Catalogs contributes to the mcp.row and mcp.install slots MCP offers', () => {
  it('declares one panel in each slot', () => {
    const panels = manifest.ui?.panels ?? [];
    expect(panels.filter(panel => panel.slot === MCP_ROW_SLOT)).toEqual([
      { slot: MCP_ROW_SLOT, id: 'mcp-row', order: 10 },
    ] as never);
    expect(panels.filter(panel => panel.slot === MCP_INSTALL_SLOT)).toEqual([
      { slot: MCP_INSTALL_SLOT, id: 'mcp-install', order: 10 },
    ] as never);
  });

  it('puts “installed from” and an Uninstall on a server a catalog install wrote, and only Publish on the rest', async () => {
    const { Row } = panelsOn(withInstall([installRecord('mcp', 'notion')]));
    const view = await mount(
      <Suspense fallback={null}>
        <Row {...serverProps('notion')} />
        <Row {...serverProps('lint')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-from]') !== null, 'the installed-from chip', interact);
    expect(q('[data-row-from]')?.textContent).toMatch(/^from .+ · v\d+$/);
    expect(rowOf('lint').querySelector('[data-row-from]')).toBeNull();
    // MCP draws the name and the scope: this contribution adds none of its own.
    expect(q('[data-row-label]')).toBeNull();
    expect(rowOf('notion').getAttribute('data-catalog-item-kind')).toBe('mcp');

    await openMenuOf('notion');
    expect(menuLabels()).toEqual(['Uninstall']);
    await view.unmount();
  });

  it('does not take a skill install of the same name for the server’s', async () => {
    const { Row } = panelsOn(withInstall([installRecord('skill', 'notion')]));
    const view = await mount(
      <Suspense fallback={null}>
        <Row {...serverProps('notion')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-more]') !== null, 'the ⋯', interact);
    expect(q('[data-row-from]')).toBeNull();
    await openMenuOf('notion');
    expect(menuLabels()).toHaveLength(1);
    expect(menuLabels()[0]).toStartWith('Publish');
    await view.unmount();
  });

  it('publishes the server by its inventory id', async () => {
    const { Row, calls } = panelsOn({
      ...withInstall([]),
      'POST /v1/catalog-items/quick-add': () => {
        throw new Error('left to the sheet');
      },
    });
    const view = await mount(
      <Suspense fallback={null}>
        <Row {...serverProps('notion')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-more]') !== null, 'the ⋯', interact);
    await openMenuOf('notion');
    await click(byText(document, '[role="menuitem"]', 'Publish'));
    await settle();
    const asked = calls.filter(call => call.key === 'POST /v1/catalog-items/quick-add');
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]?.init)).toContain('"mcp":"id-notion-project"');
    await view.unmount();
  });

  it('asks the daemon for the installs and the catalogs once for all the rows', async () => {
    const { Row, calls } = panelsOn(withInstall([]));
    const view = await mount(
      <Suspense fallback={null}>
        <Row {...serverProps('a')} />
        <Row {...serverProps('b')} />
        <Row {...serverProps('c')} />
      </Suspense>,
    );
    await settleUntil(() => document.querySelectorAll('[data-row-more]').length === 3, 'three rows', interact);
    await settle();
    expect(calls.map(call => call.key).sort()).toEqual(['GET /v1/catalog-installs', 'GET /v1/catalogs']);
    await view.unmount();
  });

  it('offers “Install from a file…” in the header and opens the file sheet from it', async () => {
    const { Install } = panelsOn(withInstall([]));
    const view = await mount(
      <Suspense fallback={null}>
        <Install subject="f1" ferret="f1" />
      </Suspense>,
    );
    await settleUntil(() => q('[data-catalog-more]') !== null, 'the More button', interact);
    expect(q('[data-catalog-file-input]')).toBeNull();
    await click(q('[data-catalog-more]'));
    await settle();
    expect(menuLabels()).toEqual(['Install from a file…For a catalog file you were handed. It works offline.']);
    await click(byText(document, '[role="menuitem"]', 'Install from a file…'));
    await settleUntil(() => q('[data-catalog-file-input]') !== null, 'the file sheet', interact);
    await view.unmount();
  });

  it('draws nothing for props that are not the slot’s, or for a client no daemon is known for', async () => {
    const { Row, Install } = panelsOn(withInstall([]));
    const none = panelsOn(withInstall([]), null);
    const view = await mount(
      <Suspense fallback={null}>
        <Row subject="f1" ferret="f1" />
        <Install subject="f1" />
        <none.Row {...serverProps('notion')} />
        <none.Install subject="f1" ferret="f1" />
      </Suspense>,
    );
    await settle();
    await settle();
    expect(q('[data-catalog-item-row]')).toBeNull();
    expect(q('[data-catalog-more]')).toBeNull();
    await view.unmount();
  });
});
