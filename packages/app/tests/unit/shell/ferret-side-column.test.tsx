import { useEffect } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type PanelProps } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import { FerretWorkspace } from '../../../src/shell/ferret-workspace.tsx';
import { useFerretWorkspace } from '../../../src/shell/ferret-workspace-actions.tsx';
import { sidePaneOpen } from '../../../src/shell/side-pane-open.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * THE FERRET PAGE IS THE CHAT AND THE COMPOSER (v4's): the side column (agenda, queue, tasks, terminals, files…) is closed
 * until the reader opens it from the toggle on the page's right edge, a panel stays mounted once drawn, and a panel another
 * panel asks for opens the column.
 */

const mounts: string[] = [];
let bring: ((panel: string) => void) | undefined;

function Note({ subject }: PanelProps) {
  useEffect(() => {
    mounts.push(String(subject));
  }, [subject]);
  return <p data-testid="side-note">note for {String(subject)}</p>;
}

/** The chat is always drawn, so it is the one that reads what a panel may ask of the workspace. */
function Chat({ words }: { readonly words: string }) {
  bring = useFerretWorkspace()?.showPanel;
  return <p data-testid="chat">{words}</p>;
}

const manifest = manifestOf('ferretpage', {
  ui: {
    screens: [
      { id: 'page', path: 'page', nav: { label: 'Page', order: 1 } },
      { id: 'other', path: 'other', nav: { label: 'Other', order: 2 } },
    ],
    panels: [{ id: 'note', slot: 'ferret.side', order: 10 }],
  },
});
const plugin = entryOf(
  manifest,
  provideToShell(
    implementApp(manifest, {
      build: () => ({
        screens: {
          page: () => <FerretWorkspace chat={<Chat words="the chat" />} daemon="d1" subject="zoe" />,
          other: () => <FerretWorkspace chat={<Chat words="the other chat" />} daemon="d1" subject="kai" />,
        },
        panels: { note: Note },
      }),
    }),
    {},
  ),
);

const layout = () => {
  const storage = memoryStore();
  writeRecord(storage, APP_STORAGE.layout, {
    nav: { style: 'list', items: ['page', 'other'] },
    side: { holds: 'panels' },
    phone: { nav: { side: 'bottom', items: ['page'] } },
    panels: { 'ferret.side': ['note'] },
    'composer.tools': [],
  });
  return storage;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  sidePaneOpen.set(false);
  mounts.length = 0;
  bring = undefined;
});

const open = async (path = '/d/d1/page') => {
  const app = await bootApp({ surfaces: [plugin], machines: ['d1'], path, storage: layout() });
  view = app.view;
  return app.view.container;
};
const toggle = (page: HTMLElement): HTMLButtonElement => {
  const button = page.querySelector<HTMLButtonElement>('[data-side-toggle]');
  if (button === null) throw new Error('no side toggle');
  return button;
};
const column = (page: HTMLElement): HTMLElement | null => page.querySelector('[data-slot="ferret.side"]');
const shown = (page: HTMLElement): boolean => {
  const slot = column(page);
  return slot !== null && slot.parentElement?.style.display !== 'none';
};

describe('the ferret page opens on the chat, with the side column one click away', () => {
  test('the column is not drawn and mounts nothing until it is opened', async () => {
    const page = await open();
    expect(page.querySelector('[data-testid="chat"]')).not.toBeNull();
    expect(column(page)).toBeNull();
    expect(page.querySelector('[data-testid="side-note"]')).toBeNull();
    expect(mounts).toEqual([]);
    expect(toggle(page).getAttribute('aria-expanded')).toBe('false');
  });

  test('the toggle opens it, and again closes it without unmounting the panels', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    expect(shown(page)).toBe(true);
    expect(page.querySelector('[data-testid="side-note"]')?.textContent).toBe('note for zoe');
    expect(toggle(page).getAttribute('aria-expanded')).toBe('true');
    await interact(() => toggle(page).click());
    await settle();
    expect(shown(page)).toBe(false);
    expect(page.querySelector('[data-testid="side-note"]')).not.toBeNull();
    expect(mounts).toEqual(['zoe']);
  });

  test('what the reader chose lasts for the visit: a column opened on one ferret is open on the next', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    await interact(() => page.querySelector<HTMLAnchorElement>('a[href="/d/d1/other"]')?.click());
    await settle();
    expect(page.querySelector('[data-testid="chat"]')?.textContent).toBe('the other chat');
    expect(shown(page)).toBe(true);
  });

  test('a panel another panel asks for opens the closed column', async () => {
    const page = await open();
    expect(column(page)).toBeNull();
    await interact(() => bring?.('note'));
    await settle();
    expect(shown(page)).toBe(true);
    expect(page.querySelector('[data-testid="side-note"]')).not.toBeNull();
  });

  test('a panel the layout did not place is not asked for, so a refused ask leaves the column closed', async () => {
    const page = await open();
    await interact(() => bring?.('insights'));
    await settle();
    expect(column(page)).toBeNull();
  });
});
