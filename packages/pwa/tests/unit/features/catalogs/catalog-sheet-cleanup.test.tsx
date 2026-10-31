import { describe, expect, it } from 'bun:test';
import { AddToCatalogSheet } from '../../../../src/features/catalogs/add-to-catalog-sheet.tsx';
import { InstallFromFileSheet } from '../../../../src/features/catalogs/install-from-file-sheet.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { mount } from '../../../support/dom.ts';
import { settle } from '../../../support/dom-form.ts';

const connection = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'token-a' });

/** What a sheet could leave behind on the page: markup, attributes, inline styles, and listeners on the window and document. */
const documentState = (): string =>
  JSON.stringify({
    body: document.body.outerHTML,
    html: document.documentElement.outerHTML.replace(document.body.outerHTML, ''),
    active: document.activeElement === document.body,
  });

const listenerBalance = async (run: () => Promise<void>): Promise<readonly string[]> => {
  const added: string[] = [];
  const removed: string[] = [];
  const restore: (() => void)[] = [];
  for (const target of [window, document] as const) {
    const add = target.addEventListener.bind(target) as (...args: unknown[]) => void;
    const remove = target.removeEventListener.bind(target) as (...args: unknown[]) => void;
    target.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      add(type, ...rest);
    }) as typeof target.addEventListener;
    target.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      remove(type, ...rest);
    }) as typeof target.removeEventListener;
    restore.push(() => {
      target.addEventListener = add as typeof target.addEventListener;
      target.removeEventListener = remove as typeof target.removeEventListener;
    });
  }
  try {
    await run();
  } finally {
    for (const undo of restore) undo();
  }
  // React itself adds `selectionchange` once per document and never removes it; it is not the sheet's.
  return added.filter(type => type !== 'selectionchange' && !removed.includes(type));
};

describe('a catalog sheet leaves the page as it found it', () => {
  it('the install sheet, opened and unmounted', async () => {
    const fake = fakeClient({
      'GET /v1/fleet/runtimes': () => ({ runtimes: [] }),
      'GET /v1/secrets': () => ({ v: 1, health: 'ready', secrets: [], references: [] }),
    });
    const before = documentState();
    const leaked = await listenerBalance(async () => {
      const view = await mount(
        <InstallFromFileSheet
          connection={connection}
          onClose={() => undefined}
          host={{ createClient: fake.factory, projects: [] }}
        />,
      );
      await settle();
      expect(document.querySelector('[data-catalog-sheet="install"]')).not.toBeNull();
      await view.unmount();
    });
    expect(documentState()).toBe(before);
    expect(leaked).toEqual([]);
  });

  it('the add sheet, opened and unmounted', async () => {
    const fake = fakeClient({ 'GET /v1/catalogs': () => ({ catalogs: [] }) });
    const before = documentState();
    const leaked = await listenerBalance(async () => {
      const view = await mount(
        <AddToCatalogSheet
          connection={connection}
          source={{ kind: 'skill', skill: '/home/k/.claude/skills/pdf-tools/SKILL.md' }}
          label="pdf-tools"
          createClient={fake.factory}
          onClose={() => undefined}
        />,
      );
      await settle();
      expect(document.querySelector('[data-catalog-sheet="add"]')).not.toBeNull();
      await view.unmount();
    });
    expect(documentState()).toBe(before);
    expect(leaked).toEqual([]);
  });
});
