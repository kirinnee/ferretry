import { describe, expect, it } from 'bun:test';
import { interact, mount, noteClientDaemon, settleUntil, ShellContext } from '@ferretry/app/testing';
import { SKILLS_ROW_SLOT } from '@ferretry/plugin-skills/contract';
import { type FunctionComponent, Suspense } from 'react';
import half from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { byText, click, settle } from '../support/dom-form.ts';
import { installRecord } from '../support/catalog-views.ts';

type Answers = Readonly<Record<string, (init: unknown) => unknown>>;

const skillProps = (name: string, extra: Record<string, unknown> = {}) => ({
  subject: 'f1',
  ferret: 'f1',
  name,
  invocation: `/${name}`,
  // The runtime-installed skill the default install fixture wrote: Ferretry's own, read by that install's runtime.
  path: `/fixtures/fleet/assets/skills/${name}/SKILL.md`,
  scope: 'ferretry',
  runtimes: ['box'],
  ...extra,
});

/** The half's `skills-row` panel on a client that answers by route key and counts every call. */
function panelOn(answers: Answers, daemon: string | null = 'alpha') {
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
  const Panel = built?.panels?.['skills-row'] as unknown as FunctionComponent<Record<string, unknown>>;
  return { Panel, calls };
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

describe('Catalogs contributes to the skills.row slot Skills offers', () => {
  it('declares one panel in skills.row and builds it', () => {
    expect(manifest.ui?.panels?.filter(panel => panel.slot === SKILLS_ROW_SLOT)).toEqual([
      { slot: SKILLS_ROW_SLOT, id: 'skills-row', order: 10 },
    ] as never);
  });

  it('puts “installed from” and an Uninstall on a skill a catalog install wrote, and only Publish on the rest', async () => {
    const { Panel } = panelOn(withInstall([installRecord('skill', 'pdf-tools')]));
    const view = await mount(
      <Suspense fallback={null}>
        <Panel {...skillProps('pdf-tools')} />
        <Panel {...skillProps('ocr')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-from]') !== null, 'the installed-from chip', interact);
    expect(q('[data-row-from]')?.textContent).toMatch(/^from .+ · v\d+$/);
    expect(rowOf('ocr').querySelector('[data-row-from]')).toBeNull();
    // The host draws the name and the scope: this contribution adds none of its own.
    expect(q('[data-row-label]')).toBeNull();
    expect(q('[data-row-scope]')).toBeNull();

    await openMenuOf('pdf-tools');
    expect(menuLabels()).toEqual(['Uninstall']);
    await view.unmount();
  });

  it('offers Publish, and no Uninstall, on a skill no catalog install wrote', async () => {
    const { Panel } = panelOn(withInstall([installRecord('skill', 'pdf-tools')]));
    const view = await mount(
      <Suspense fallback={null}>
        <Panel {...skillProps('ocr')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-more]') !== null, 'the ⋯', interact);
    await openMenuOf('ocr');
    expect(menuLabels()).toHaveLength(1);
    expect(menuLabels()[0]).toStartWith('Publish');
    await view.unmount();
  });

  it('names the machine by the paired list when this browser is paired with it', async () => {
    const { Panel } = panelOn(withInstall([]));
    const paired = { daemon: 'alpha', machine: 'kirin-box', deviceId: 'd', address: 'https://daemon.test' };
    const list = { daemons: [paired], selected: null };
    const shell = { runtime: { daemons: { snapshot: () => list, subscribe: () => () => {} } } } as never;
    const view = await mount(
      <ShellContext.Provider value={shell}>
        <Suspense fallback={null}>
          <Panel {...skillProps('ocr')} />
        </Suspense>
      </ShellContext.Provider>,
    );
    await settleUntil(() => q('[data-row-more]') !== null, 'the ⋯', interact);
    await openMenuOf('ocr');
    expect(menuLabels()[0]).toContain('kirin-box');
    await view.unmount();
  });

  it('asks the daemon for the installs and the catalogs once for all the rows', async () => {
    const { Panel, calls } = panelOn(withInstall([]));
    const view = await mount(
      <Suspense fallback={null}>
        <Panel {...skillProps('a')} />
        <Panel {...skillProps('b')} />
        <Panel {...skillProps('c')} />
      </Suspense>,
    );
    await settleUntil(() => document.querySelectorAll('[data-row-more]').length === 3, 'three rows', interact);
    await settle();
    expect(calls.map(call => call.key).sort()).toEqual(['GET /v1/catalog-installs', 'GET /v1/catalogs']);
    await view.unmount();
  });

  it('uninstalls from the row, then every row reads the lists again', async () => {
    const install = installRecord('skill', 'pdf-tools');
    let installs = [install];
    const { Panel, calls } = panelOn({
      'GET /v1/catalog-installs': () => ({ installs }),
      'GET /v1/catalogs': () => ({ catalogs: [] }),
      'DELETE /v1/catalog-installs/runtime/:installId': () => {
        installs = [];
        return { installId: install.installId, provenance: install.provenance, destination: install.destination };
      },
    });
    const view = await mount(
      <Suspense fallback={null}>
        <Panel {...skillProps('pdf-tools')} />
      </Suspense>,
    );
    await settleUntil(() => q('[data-row-from]') !== null, 'the installed-from chip', interact);
    await openMenuOf('pdf-tools');
    await click(byText(document, '[role="menuitem"]', 'Uninstall'));
    await settle();
    expect(q('[data-catalog-remove-confirm]')?.textContent).toContain('Uninstall pdf-tools');
    await click(q('[data-catalog-remove-yes]'));
    await settleUntil(() => q('[data-row-from]') === null, 'the chip gone after the uninstall', interact);
    expect(calls.map(call => call.key).filter(key => key.startsWith('DELETE'))).toHaveLength(1);
    expect(calls.filter(call => call.key === 'GET /v1/catalog-installs')).toHaveLength(2);
    await view.unmount();
  });

  it('draws nothing for props that are not the slot’s, or for a client no daemon is known for', async () => {
    const { Panel } = panelOn(withInstall([]));
    const none = panelOn(withInstall([]), null);
    const view = await mount(
      <Suspense fallback={null}>
        <Panel subject="f1" ferret="f1" />
        <none.Panel {...skillProps('pdf-tools')} />
      </Suspense>,
    );
    await settle();
    await settle();
    expect(q('[data-catalog-item-row]')).toBeNull();
    await view.unmount();
  });
});
