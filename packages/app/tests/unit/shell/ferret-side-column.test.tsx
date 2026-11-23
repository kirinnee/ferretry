import { useEffect } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp, type PanelProps } from '@ferretry/kernel/manifest';
import { provideToShell } from '../../../src/connect/provides.ts';
import { storedOverrides } from '../../../src/layout/device-layout.ts';
import { FerretWorkspace } from '../../../src/shell/ferret-workspace.tsx';
import { useFerretWorkspace } from '../../../src/shell/ferret-workspace-actions.tsx';
import { panelWidths } from '../../../src/shell/panel-widths.ts';
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
/** A running session's stream, faked: opened when its panel mounts, closed when it unmounts. Switching tabs must do neither. */
const stream = { opened: 0, closed: 0, node: null as HTMLElement | null };
/** What Agenda's `ferrets.needs-you` provider says, by ferret: items on the owner's turn, and whether the chat draws the line. */
interface Entry {
  readonly waitingOnOwner: number;
  readonly lineShown: boolean;
}
const waiting = new Map<string, Entry>();
const heard = new Set<() => void>();
const setWaiting = (ferret: string, waitingOnOwner: number, lineShown = false): void => {
  if (waitingOnOwner === 0) waiting.delete(ferret);
  else waiting.set(ferret, { waitingOnOwner, lineShown });
  for (const listener of [...heard]) listener();
};
let bring: ((panel: string) => void) | undefined;

function Note({ subject }: PanelProps) {
  useEffect(() => {
    mounts.push(String(subject));
    stream.opened += 1;
    return () => {
      stream.closed += 1;
    };
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
    panels: [
      { id: 'note', slot: 'ferret.side', order: 10 },
      { id: 'files', slot: 'ferret.side', order: 20 },
    ],
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
        panels: { note: Note, files: () => <p data-testid="side-files">files</p> },
      }),
    }),
    {
      hooks: {
        'ferrets.needs-you': () => {
          let snapshot: ReadonlyMap<string, Entry> = new Map(waiting);
          return {
            subscribe: (listener: () => void) => {
              heard.add(listener);
              return () => void heard.delete(listener);
            },
            watch: () => () => undefined,
            needing: () => {
              if (snapshot.size !== waiting.size || [...waiting].some(([id, ask]) => snapshot.get(id) !== ask))
                snapshot = new Map(waiting);
              return snapshot;
            },
          };
        },
      },
    },
  ),
);

const layout = () => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      nav: { style: 'list', items: ['page', 'other'] },
      side: { holds: 'panels' },
      phone: { nav: { side: 'bottom', items: ['page'] } },
      panels: { 'ferret.side': ['note', 'files'] },
      'composer.tools': [],
    }),
  );
  return storage;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  sidePaneOpen.set(false);
  panelWidths.forget();
  mounts.length = 0;
  stream.opened = 0;
  stream.closed = 0;
  waiting.clear();
  heard.clear();
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

  test('an address that names a file (`?file=`, from Projects’ file finder) opens the closed column on that panel', async () => {
    const page = await open('/d/d1/page?file=src%2Fentry-ts');
    await settle();
    expect(shown(page)).toBe(true);
    expect(page.querySelector('[data-testid="side-files"]')).not.toBeNull();
  });

  test('an address with no file leaves the column closed', async () => {
    const page = await open('/d/d1/page?find=entry');
    await settle();
    expect(column(page)).toBeNull();
  });

  test('a panel the layout did not place is not asked for, so a refused ask leaves the column closed', async () => {
    const page = await open();
    await interact(() => bring?.('insights'));
    await settle();
    expect(column(page)).toBeNull();
  });
});

const tab = (page: HTMLElement, key: string): HTMLButtonElement => {
  const chip = page.querySelector<HTMLButtonElement>(`[data-ferret-side] [data-phone-chip="${key}"]`);
  if (chip === null) throw new Error(`no tab ${key}`);
  return chip;
};
const onShow = (page: HTMLElement): string[] =>
  [...page.querySelectorAll('[data-ferret-side] [data-panel][data-phone-shown]')].map(
    node => node.getAttribute('data-panel') ?? '',
  );
const handle = (page: HTMLElement): HTMLElement => {
  const strip = page.querySelector<HTMLElement>('[data-resize-handle="ferret-side"]');
  if (strip === null) throw new Error('no resize handle');
  return strip;
};
const press = async (node: HTMLElement, key: string): Promise<void> => {
  await interact(() => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

describe('the open side column is a row of tabs over ONE panel, with a draggable edge', () => {
  test('it opens on the first tab and draws only that panel; the others stay mounted behind it', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    const tabs = [...page.querySelectorAll('[data-ferret-side] [role="tab"]')].map(node =>
      node.getAttribute('data-phone-chip'),
    );
    expect(tabs).toEqual(['ferretpage.files', 'ferretpage.note']);
    expect(onShow(page)).toEqual(['ferretpage.files']);
    expect(page.querySelector('[data-testid="side-note"]')).not.toBeNull();
  });

  test('a tab switches the panel on show', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    await interact(() => tab(page, 'ferretpage.note').click());
    expect(onShow(page)).toEqual(['ferretpage.note']);
    expect(tab(page, 'ferretpage.note').getAttribute('aria-selected')).toBe('true');
    expect(tab(page, 'ferretpage.files').getAttribute('aria-selected')).toBe('false');
  });

  test('a running session keeps its stream across tab switches: nothing remounts or reconnects', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    await interact(() => tab(page, 'ferretpage.note').click());
    expect(stream.opened, 'the stream connected once, when its panel first mounted').toBe(1);
    const node = page.querySelector('[data-testid="side-note"]');
    expect(node).not.toBeNull();
    for (let round = 0; round < 3; round += 1) {
      await interact(() => tab(page, 'ferretpage.files').click());
      await interact(() => tab(page, 'ferretpage.note').click());
    }
    await settle();
    expect(page.querySelector('[data-testid="side-note"]'), 'the very same element, never a remount').toBe(node);
    expect(stream.opened, 'no reconnect').toBe(1);
    expect(stream.closed, 'no disconnect').toBe(0);
    expect(mounts).toEqual(['zoe']);
    // Hiding the column keeps it too.
    await interact(() => toggle(page).click());
    await settle();
    expect([stream.opened, stream.closed]).toEqual([1, 0]);
  });

  test('a panel another panel asks for is the tab that opens', async () => {
    const page = await open();
    await interact(() => bring?.('note'));
    await settle();
    expect(onShow(page)).toEqual(['ferretpage.note']);
  });

  test('the toggle is inside the tab row while open and on the slim rail while closed — never both', async () => {
    const page = await open();
    expect(page.querySelector('[data-side-rail] [data-side-toggle]')).not.toBeNull();
    await interact(() => toggle(page).click());
    await settle();
    expect(page.querySelector('[data-side-rail]')).toBeNull();
    expect(page.querySelector('[data-phone-tab-row] [data-side-toggle]')).not.toBeNull();
    expect(page.querySelectorAll('[data-side-toggle]').length).toBe(1);
  });

  test('the divider is a keyboard-resizable separator with the allowed range, and Home puts it back', async () => {
    const page = await open();
    await interact(() => toggle(page).click());
    await settle();
    const strip = handle(page);
    expect(strip.getAttribute('role')).toBe('separator');
    expect(strip.getAttribute('aria-valuemin')).toBe('300');
    expect(strip.getAttribute('aria-valuemax')).toBe('720');
    await press(strip, 'ArrowLeft');
    expect(panelWidths.width('ferret-side')).toBe(316);
    await press(strip, 'ArrowRight');
    await press(strip, 'ArrowRight');
    expect(panelWidths.width('ferret-side')).toBe(300); // never below its minimum
    for (let step = 0; step < 40; step += 1) await press(strip, 'ArrowLeft');
    expect(panelWidths.width('ferret-side')).toBe(720); // never above its maximum
    await press(strip, 'Home');
    expect(panelWidths.width('ferret-side')).toBeUndefined();
  });

  test('a closed column draws no divider', async () => {
    const page = await open();
    expect(page.querySelector('[data-resize-handle="ferret-side"]')).toBeNull();
  });
});

describe('a closed side column says how many asks wait behind it', () => {
  test('a ferret with open asks puts the count on the toggle, and its label says it', async () => {
    waiting.set('zoe', { waitingOnOwner: 3, lineShown: false });
    const page = await open();
    await settle();
    expect(page.querySelector('[data-side-toggle-count]')?.textContent).toBe('3');
    expect(toggle(page).getAttribute('aria-label')).toBe('Show side panels, 3 asks wait on you');
  });

  test('one ask reads in the singular, and the count follows the provider live', async () => {
    waiting.set('zoe', { waitingOnOwner: 1, lineShown: false });
    const page = await open();
    await settle();
    expect(toggle(page).getAttribute('aria-label')).toBe('Show side panels, 1 ask waits on you');
    await interact(() => setWaiting('zoe', 4));
    expect(page.querySelector('[data-side-toggle-count]')?.textContent).toBe('4');
    await interact(() => setWaiting('zoe', 0));
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
    expect(toggle(page).getAttribute('aria-label')).toBe('Show side panels');
  });

  test('only THIS ferret’s asks count, and an open column draws no count (its agenda tab says them)', async () => {
    waiting.set('kai', { waitingOnOwner: 5, lineShown: false });
    const page = await open();
    await settle();
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
    await interact(() => setWaiting('zoe', 2));
    expect(page.querySelector('[data-side-toggle-count]')?.textContent).toBe('2');
    await interact(() => toggle(page).click());
    await settle();
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
    expect(toggle(page).getAttribute('aria-label')).toBe('Hide side panels');
  });
  test('agenda mode ON: the chat draws the agenda line, so the toggle draws no badge (the asks are not said twice)', async () => {
    waiting.set('zoe', { waitingOnOwner: 3, lineShown: true });
    const page = await open();
    await settle();
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
    expect(toggle(page).getAttribute('aria-label')).toBe('Show side panels');
    await interact(() => setWaiting('zoe', 3, false));
    expect(page.querySelector('[data-side-toggle-count]')?.textContent).toBe('3');
    await interact(() => setWaiting('zoe', 3, true));
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
  });

  test('items that wait on the ferret are not asks on the owner: with none on the owner the toggle draws no badge', async () => {
    // Agenda counts `waitingOnOwner` from the owner's turn only; a ferret whose items all moved to the ferret's turn has 0.
    waiting.set('zoe', { waitingOnOwner: 0, lineShown: false });
    const page = await open();
    await settle();
    expect(page.querySelector('[data-side-toggle-count]')).toBeNull();
    expect(toggle(page).getAttribute('aria-label')).toBe('Show side panels');
  });
});
