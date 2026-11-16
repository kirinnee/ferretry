import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/core-asks/contract';
import { Markdown } from '../../../../app/shell.ts';
import { AgendaItemView } from '../../../../app/features/agenda/agenda-item-view.tsx';
import { AgendaTabs } from '../../../../app/features/agenda/agenda-tabs.tsx';
import type { AgendaVersionsView } from '../../../../app/features/agenda/use-item-lifecycle.ts';
import { agendaItem, choices } from '../../../support/app/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '@ferretry/app/testing';
import { settleUntil } from '@ferretry/app/testing';

/**
 * THE TABS (&F923; docs/agenda.md § The tabs): the item's live document — "Where we are now" first and open, "The full
 * picture", then the ferret's own tabs. Wider, a wrapping ARIA tablist; on a phone, one switcher and a bottom sheet.
 */

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
const setViewport = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
};

let view: Mounted | null = null;
beforeEach(() => {
  window.localStorage.clear();
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
  window.localStorage.clear();
});

const tabbed = agendaItem('A23', {
  title: 'Relay plan',
  ask: choices('Ship', 'Wait'),
  whereWeAre: '## Status\nBuilding the relay.',
  questionAnswer: 'Yes, it pauses.',
  body: 'The whole report.',
  tabs: [
    { id: 'decisions', name: 'Decisions', body: 'We chose SQLite.' },
    { id: 'risks', name: 'Risks', body: 'The export may slip.' },
  ],
  revisions: [
    {
      at: '2026-08-01T11:00:00.000Z',
      by: 'agent',
      changed: ['whereWeAre', 'tabs'],
      previous: {
        whereWeAre: 'Planning.',
        tabs: [{ id: 'decisions', name: 'Decisions', body: 'We chose SQLite.' }],
      },
    },
  ],
} as unknown as Partial<AgendaItem>);

const draw = async (
  item: AgendaItem = tabbed,
  itemKey = 'laptop/sess-1/A23',
  versions?: AgendaVersionsView,
): Promise<void> => {
  view = await mount(
    <AgendaItemView
      {...(versions === undefined ? {} : { versions })}
      busy={false}
      error={null}
      ferret="Zoe"
      history={[]}
      item={item}
      itemKey={itemKey}
      now={NOW}
      onAct={() => undefined}
      onClose={() => undefined}
      position={{ index: 0, total: 1 }}
      renderProse={text => <Markdown text={text} />}
      swipeable={false}
    />,
  );
};

const root = (): HTMLElement => must(view?.container, 'the view');
const one = <T extends Element>(selector: string, within: ParentNode = root()): T =>
  must(within.querySelector<T>(selector), selector);
const selected = (): string | null => one('[role="tab"][aria-selected="true"]').getAttribute('data-agenda-tab-button');

describe('the tabs, wider than a phone', () => {
  test('are a tablist in the protocol’s order, the main tab open, only its words in the page', async () => {
    await draw();
    const tabs = [...root().querySelectorAll('[role="tab"]')];
    expect(tabs.map(tab => tab.textContent)).toEqual([
      'Where we are nowChanged',
      'The full picture',
      'Decisions',
      'RisksChanged',
    ]);
    expect(selected()).toBe('main');
    expect(one('[data-agenda-tab-row]').getAttribute('data-agenda-tab-row')).toBe('wrap');
    const panel = one('[role="tabpanel"]');
    expect(panel.getAttribute('aria-labelledby')).toBe(one('[role="tab"][aria-selected="true"]').id);
    expect(panel.textContent).toContain('Building the relay.');
    expect(panel.textContent).not.toContain('The whole report.');
    // A changed tab says so in words too, never by colour alone.
    expect(one('[data-agenda-tab-button="risks"] [data-agenda-tab-changed] .sr-only').textContent).toBe('Changed');
  });

  test('move with the arrows, Home and End, focus following the open tab', async () => {
    await draw();
    const list = one<HTMLElement>('[role="tablist"]');
    await interact(() => pressKey(list, 'ArrowRight'));
    expect(selected()).toBe('body');
    expect(document.activeElement?.getAttribute('data-agenda-tab-button')).toBe('body');
    await interact(() => pressKey(list, 'End'));
    expect(selected()).toBe('risks');
    expect(one('[role="tabpanel"]').textContent).toContain('The export may slip.');
    await interact(() => pressKey(list, 'ArrowRight'));
    expect(selected()).toBe('main');
    await interact(() => pressKey(list, 'x'));
    expect(selected()).toBe('main');
  });

  test('end each tab with a Next link to the one after it, and the last with none', async () => {
    await draw();
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-next]').click());
    expect(selected()).toBe('body');
    expect(one('[data-agenda-tab-next]').textContent).toBe('Next: Decisions');
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="risks"]').click());
    expect(root().querySelector('[data-agenda-tab-next]')).toBeNull();
  });

  test('remember the open tab per item on this device, and fall back to the main tab', async () => {
    await draw();
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="decisions"]').click());
    await view?.unmount();
    await draw();
    expect(selected()).toBe('decisions');
    await view?.unmount();
    // Another item starts on its main tab.
    await draw(tabbed, 'laptop/sess-1/A24');
    expect(selected()).toBe('main');
    await view?.unmount();
    // A remembered tab the item no longer has falls back to the main tab.
    await draw(agendaItem('A23', { ...tabbed, tabs: undefined } as unknown as Partial<AgendaItem>));
    expect(selected()).toBe('main');
    // Back on the main tab, nothing is kept.
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="body"]').click());
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="main"]').click());
    expect(window.localStorage.getItem('fy.agenda.tab.v1:laptop/sess-1/A23')).toBeNull();
  });

  test('“Answered: see Where we are now” opens the main tab from any other', async () => {
    await draw();
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="risks"]').click());
    await interact(() => one<HTMLButtonElement>('[data-agenda-answered-line] button').click());
    expect(selected()).toBe('main');
    expect(one('[role="tabpanel"] [data-agenda-question-answer]').textContent).toContain('Yes, it pauses.');
  });

  test('draw the full picture in a notice’s ask, never as a tab', async () => {
    await draw(
      agendaItem('A30', {
        kind: 'info',
        notice: true,
        whereWeAre: 'Shipped.',
        body: 'The release notes.',
      } as unknown as Partial<AgendaItem>),
    );
    expect(root().querySelector('[data-agenda-tab-button="body"]')).toBeNull();
    expect(one('[data-agenda-part="tabs"] > h4').textContent).toBe('Where we are now');
  });
});

describe('the tabs on a phone', () => {
  /** The row's measures, as a browser would lay out four tabs wider than a 390px phone. */
  const laidOut = (row: HTMLElement, scrollWidth: number, clientWidth: number): void => {
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: scrollWidth });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: clientWidth });
  };

  test('are the same tablist, on one line that scrolls sideways — never a dropdown or a sheet (&F946)', async () => {
    setViewport(390);
    await draw();
    expect(one('[data-agenda-tab-row]').getAttribute('data-agenda-tab-row')).toBe('scroll');
    const tabs = [...root().querySelectorAll('[role="tablist"] [role="tab"]')];
    expect(tabs.map(tab => tab.getAttribute('data-agenda-tab-button'))).toEqual(['main', 'body', 'decisions', 'risks']);
    const part = one('[data-agenda-part="tabs"]');
    expect(part.querySelector('[aria-haspopup]')).toBeNull();
    expect(document.body.querySelector('[data-agenda-tab-sheet], [data-agenda-tab-switch]')).toBeNull();
    // The changed dot stays, and Next still moves on.
    expect(root().querySelectorAll('[role="tab"] [data-agenda-tab-changed]')).toHaveLength(2);
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-next]').click());
    expect(selected()).toBe('body');
  });

  test('fade the end that hides more tabs, and follow the scroll', async () => {
    setViewport(390);
    await draw();
    const row = one<HTMLElement>('[role="tablist"]');
    const wrapper = one('[data-agenda-tab-row]');
    expect(wrapper.hasAttribute('data-more-end')).toBe(false);
    laidOut(row, 600, 358);
    await interact(() => row.dispatchEvent(new Event('scroll')));
    expect(wrapper.hasAttribute('data-more-end')).toBe(true);
    expect(wrapper.hasAttribute('data-more-start')).toBe(false);
    row.scrollLeft = 120;
    await interact(() => row.dispatchEvent(new Event('scroll')));
    expect(wrapper.hasAttribute('data-more-start')).toBe(true);
    expect(wrapper.hasAttribute('data-more-end')).toBe(true);
    row.scrollLeft = 242;
    await interact(() => row.dispatchEvent(new Event('scroll')));
    expect(wrapper.hasAttribute('data-more-end')).toBe(false);
  });

  test('scroll the open tab into the row, sideways only', async () => {
    setViewport(390);
    await draw();
    const row = one<HTMLElement>('[role="tablist"]');
    laidOut(row, 600, 358);
    const place = (id: string, left: number, width: number): void => {
      const tab = one<HTMLElement>(`[data-agenda-tab-button="${id}"]`);
      Object.defineProperty(tab, 'offsetLeft', { configurable: true, value: left });
      Object.defineProperty(tab, 'offsetWidth', { configurable: true, value: width });
    };
    place('main', 0, 160);
    place('body', 160, 150);
    place('decisions', 310, 120);
    place('risks', 430, 100);
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="risks"]').click());
    expect(row.scrollLeft).toBe(430 + 100 - 358 + 24);
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="decisions"]').click());
    // Already in view: the row stays where it is.
    expect(row.scrollLeft).toBe(196);
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-button="body"]').click());
    expect(row.scrollLeft).toBe(136);
  });
});

describe('the tabs and the versions this device saw', () => {
  // The version this device last saw: the same item before Risks was rewritten.
  const seenItem = {
    ...tabbed,
    tabs: [
      { id: 'decisions', name: 'Decisions', body: 'We chose SQLite.' },
      { id: 'risks', name: 'Risks', body: 'Nothing yet.' },
    ],
    revisions: undefined,
  } as unknown as AgendaItem;
  // The newest edit only renamed the item: by its last edit alone, no tab changed.
  const retitled = {
    ...tabbed,
    title: 'Relay plan, final',
    revisions: [{ at: '2026-08-01T11:30:00.000Z', by: 'agent', changed: ['title'], previous: { title: 'Relay plan' } }],
  } as unknown as AgendaItem;
  const versionsOf = (now: AgendaItem): AgendaVersionsView => ({
    list: { sessionId: 's', id: 'A23', latest: 3, seen: 1, versions: [] } as never,
    load: async version => (version === 1 ? seenItem : now),
  });
  const marked = (): string[] =>
    [...root().querySelectorAll('[data-agenda-tab-button]')]
      .filter(tab => tab.querySelector('[data-agenda-tab-changed]') !== null)
      .map(tab => tab.getAttribute('data-agenda-tab-button') ?? '');

  test('mark what changed since the version seen, even when a later edit only touched the title', async () => {
    await draw(retitled, 'laptop/sess-1/A23', versionsOf(retitled));
    await settleUntil(() => marked().length > 0, 'the marks since the version seen', interact);
    expect(marked()).toEqual(['risks']);
  });

  test('a changed section in Changes opens its tab', async () => {
    await draw(tabbed, 'laptop/sess-1/A23', versionsOf(tabbed));
    // Changes is in the item's ⋯ menu.
    await interact(() => one<HTMLButtonElement>('.fy-item-view__bar [data-agenda-menu-toggle]').click());
    await interact(() =>
      must(document.body.querySelector<HTMLButtonElement>('[data-agenda-diff-toggle]'), 'Changes').click(),
    );
    await settleUntil(() => root().querySelector('[data-agenda-diff-open-tab]') !== null, 'the diff', interact);
    const open = one<HTMLButtonElement>('[data-agenda-diff-open-tab="risks"]');
    expect(open.getAttribute('aria-label')).toBe('Open the tab Risks');
    await interact(() => open.click());
    expect(selected()).toBe('risks');
  });
});

describe('the phone row as it changes (&F946 round 1)', () => {
  const own = [
    { id: 'first', kind: 'own' as const, name: 'First', body: 'a' },
    { id: 'second', kind: 'own' as const, name: 'Second', body: 'b' },
  ];
  const tabsOf = (tabs: typeof own, open = 'second') => (
    <AgendaTabs
      changed={new Set<string>()}
      mark={text => text}
      onOpen={() => undefined}
      open={open}
      renderProse={text => text}
      tabs={tabs}
    />
  );

  test('remeasures a renamed tab, with the same number of tabs', async () => {
    setViewport(390);
    view = await mount(tabsOf(own));
    const row = one<HTMLElement>('[role="tablist"]');
    let wide = 300;
    Object.defineProperty(row, 'scrollWidth', { configurable: true, get: () => wide });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 350 });
    await interact(() => row.dispatchEvent(new Event('scroll')));
    expect(one('[data-agenda-tab-row]').hasAttribute('data-more-end')).toBe(false);
    wide = 600;
    await view.render(
      tabsOf([{ ...own[0], name: 'A much longer renamed first tab' } as (typeof own)[0], own[1] as (typeof own)[0]]),
    );
    expect(one('[data-agenda-tab-row]').hasAttribute('data-more-end')).toBe(true);
  });

  test('keeps the open tab in view when the row resizes', async () => {
    setViewport(390);
    const original = globalThis.ResizeObserver;
    const watched: { readonly target: Element; readonly resize: () => void }[] = [];
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: () => void) {}
      observe(target: Element): void {
        watched.push({ target, resize: this.callback });
      }
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    try {
      view = await mount(tabsOf(own));
      const row = one<HTMLElement>('[role="tablist"]');
      const open = one<HTMLElement>('[data-agenda-tab-button="second"]');
      let width = 350;
      Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 500 });
      Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => width });
      Object.defineProperty(open, 'offsetLeft', { configurable: true, value: 250 });
      Object.defineProperty(open, 'offsetWidth', { configurable: true, value: 100 });
      // Each tab is watched too: a font loading resizes a tab without resizing the row.
      expect(watched.some(entry => entry.target === open)).toBe(true);
      width = 200;
      await interact(() => watched.find(entry => entry.target === row)?.resize());
      expect(row.scrollLeft).toBe(250 + 100 - 200 + 24);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test('drops the fade when the phone becomes a wider screen', async () => {
    setViewport(390);
    const crossings: (() => void)[] = [];
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        addEventListener: (_type: string, callback: () => void) => crossings.push(callback),
        removeEventListener: () => undefined,
      }),
    });
    await draw();
    const row = one<HTMLElement>('[role="tablist"]');
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 350 });
    await interact(() => row.dispatchEvent(new Event('scroll')));
    expect(one('[data-agenda-tab-row]').hasAttribute('data-more-end')).toBe(true);
    await interact(() => {
      window.innerWidth = 1440;
      for (const crossing of crossings) crossing();
    });
    expect(one('[data-agenda-tab-row]').getAttribute('data-agenda-tab-row')).toBe('wrap');
    expect(one('[data-agenda-tab-row]').hasAttribute('data-more-end')).toBe(false);
  });
});
