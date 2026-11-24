import { afterEach, describe, expect, test } from 'bun:test';
import { defineEvent } from '@ferretry/kernel/contract';
import { implementApp, type PanelIntent, type PanelProps } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { provideToShell } from '../../../src/connect/provides.ts';
import { storedOverrides } from '../../../src/layout/device-layout.ts';
import { FerretWorkspace } from '../../../src/shell/ferret-workspace.tsx';
import { CARD_MODAL_ATTRIBUTE, revealDecision, usePanelRevealMark } from '../../../src/shell/panel-reveal.ts';
import { sidePaneOpen } from '../../../src/shell/side-pane-open.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * A PAGE THE AGENT OPENS SHOWS AT ONCE (`PanelReveal`): the Browser panel declares `reveal: { on, when: 'opened' }`; the ferret
 * page's workspace hears the event. The ferret on screen switches to that panel with a `show-page` intent for the page; any
 * other ferret, and a phone with a sign-in card modal open, only get a mark.
 */

const PageChanged = defineEvent(
  'ferretpage.page-changed',
  z.strictObject({
    ferret: z.string(),
    page: z.string(),
    change: z.enum(['opened', 'closed', 'driving']),
  }),
);

/** The intents the stand-in Browser panel was handed, newest last. */
const intents: PanelIntent[] = [];

function Browser({ intent }: PanelProps) {
  if (intent !== undefined && !intents.some(seen => seen.id === intent.id)) intents.push(intent);
  return <p data-testid="browser">browser</p>;
}

function Mark({ ferret }: { readonly ferret: string }) {
  return usePanelRevealMark('d1', ferret) ? <i data-testid={`mark-${ferret}`} /> : null;
}

/** The chat is drawn on every tab, so the marks (normally on the list's rows) are read from it. */
function Chat() {
  return (
    <div data-testid="chat">
      <Mark ferret="zoe" />
      <Mark ferret="kai" />
    </div>
  );
}

const manifest = manifestOf('ferretpage', {
  ui: {
    screens: [{ id: 'page', path: 'page', nav: { label: 'Page', order: 1 } }],
    panels: [
      { id: 'terminals', slot: 'ferret.side', order: 10 },
      { id: 'browser', slot: 'ferret.side', order: 20, reveal: { on: PageChanged, when: 'opened' } },
    ],
  },
  data: { publishes: [PageChanged] },
});
const plugin = entryOf(
  manifest,
  provideToShell(
    implementApp(manifest, {
      build: () => ({
        screens: { page: () => <FerretWorkspace chat={<Chat />} daemon="d1" subject="zoe" /> },
        panels: { terminals: () => <p data-testid="note">note</p>, browser: Browser },
      }),
    }),
    {},
  ),
);

const layout = () => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      nav: { style: 'list', items: ['page'] },
      side: { holds: 'panels' },
      phone: { nav: { side: 'bottom', items: ['page'] } },
      panels: { 'ferret.side': ['terminals', 'browser'] },
      'composer.tools': [],
    }),
  );
  return storage;
};

let view: Mounted | null = null;
const wideWidth = window.innerWidth;
afterEach(async () => {
  window.innerWidth = wideWidth;
  await view?.unmount();
  view = null;
  sidePaneOpen.set(false);
  document.documentElement.removeAttribute(CARD_MODAL_ATTRIBUTE);
  intents.length = 0;
});

const boot = async (viewport?: 'phone') => {
  // The workspace picks the phone's chips from the window's width, not from the shell's media query.
  if (viewport === 'phone') window.innerWidth = 390;
  const app = await bootApp({
    surfaces: [plugin],
    machines: ['d1'],
    path: '/d/d1/page',
    storage: layout(),
    ...(viewport === undefined ? {} : { viewport }),
  });
  view = app.view;
  return app;
};
const hear = async (
  app: Awaited<ReturnType<typeof boot>>,
  ferret: string,
  page: string,
  change = 'opened',
): Promise<void> => {
  await interact(() => app.machine('d1').transport.emit({ name: PageChanged.name, payload: { ferret, page, change } }));
  await settle();
};
const onShow = (page: HTMLElement): string[] =>
  [...page.querySelectorAll('[data-ferret-side] [data-panel][data-phone-shown]')].map(
    node => node.getAttribute('data-panel') ?? '',
  );
const toggle = (page: HTMLElement): HTMLButtonElement => {
  const button = page.querySelector<HTMLButtonElement>('[data-side-toggle]');
  if (button === null) throw new Error('no side toggle');
  return button;
};

describe('the decision', () => {
  test('is show for the ferret on screen, mark for any other, mark on a phone while a card modal is open', () => {
    const base = { ferret: 'zoe', subject: 'zoe', phone: false, modalOpen: false };
    expect(revealDecision(base)).toBe('show');
    expect(revealDecision({ ...base, ferret: 'kai' })).toBe('mark');
    expect(revealDecision({ ...base, phone: true })).toBe('show');
    expect(revealDecision({ ...base, phone: true, modalOpen: true })).toBe('mark');
    expect(revealDecision({ ...base, modalOpen: true }), 'a wide screen keeps the modal beside the panel').toBe('show');
  });
});

describe('a page the agent opens', () => {
  test('on the ferret on screen: the column opens on the Browser panel, which is handed that page', async () => {
    const app = await boot();
    const page = app.view.container;
    await interact(() => toggle(page).click());
    await settle();
    expect(onShow(page)).toEqual(['ferretpage.terminals']);
    await hear(app, 'zoe', 'p7');
    expect(onShow(page)).toEqual(['ferretpage.browser']);
    expect(intents.at(-1)).toMatchObject({ action: 'show-page', target: 'p7' });
    expect(page.querySelector('[data-testid="mark-zoe"]')).toBeNull();
  });

  test('on a closed column: it opens', async () => {
    const app = await boot();
    const page = app.view.container;
    expect(page.querySelector('[data-ferret-side]')).toBeNull();
    await hear(app, 'zoe', 'p7');
    expect(onShow(page)).toEqual(['ferretpage.browser']);
  });

  test('a second page is a second request, so the panel selects it too', async () => {
    const app = await boot();
    await hear(app, 'zoe', 'p7');
    await hear(app, 'zoe', 'p8');
    expect(intents.map(each => each.target)).toEqual(['p7', 'p8']);
    expect(intents.at(-1)?.target).toBe('p8');
  });

  test('on another ferret: nothing switches, and that ferret is marked', async () => {
    const app = await boot();
    const page = app.view.container;
    await interact(() => toggle(page).click());
    await settle();
    await hear(app, 'kai', 'p1');
    expect(onShow(page)).toEqual(['ferretpage.terminals']);
    expect(intents).toEqual([]);
    expect(page.querySelector('[data-testid="mark-kai"]')).not.toBeNull();
    expect(page.querySelector('[data-testid="mark-zoe"]')).toBeNull();
  });

  test('another kind of change does not ask for the panel', async () => {
    const app = await boot();
    await hear(app, 'zoe', 'p7', 'driving');
    expect(app.view.container.querySelector('[data-ferret-side]')).toBeNull();
  });
});

describe('on the phone', () => {
  test('the Browser chip comes on screen', async () => {
    const app = await boot('phone');
    const page = app.view.container;
    expect(page.querySelector('[data-phone-workspace]')?.getAttribute('data-phone-tab')).toBe('chat');
    await hear(app, 'zoe', 'p7');
    expect(page.querySelector('[data-phone-workspace]')?.getAttribute('data-phone-tab')).toBe('ferretpage.browser');
    expect(intents.at(-1)).toMatchObject({ action: 'show-page', target: 'p7' });
  });

  test('with a sign-in card modal open it does not move: the ferret is marked instead, and the mark clears once the panel is seen', async () => {
    const app = await boot('phone');
    const page = app.view.container;
    document.documentElement.setAttribute(CARD_MODAL_ATTRIBUTE, 'open');
    await hear(app, 'zoe', 'p7');
    expect(page.querySelector('[data-phone-workspace]')?.getAttribute('data-phone-tab')).toBe('chat');
    expect(intents).toEqual([]);
    expect(page.querySelector('[data-testid="mark-zoe"]')).not.toBeNull();
    document.documentElement.removeAttribute(CARD_MODAL_ATTRIBUTE);
    await interact(() => page.querySelector<HTMLButtonElement>('[data-phone-chip="ferretpage.browser"]')?.click());
    await settle();
    expect(page.querySelector('[data-testid="mark-zoe"]')).toBeNull();
  });
});
