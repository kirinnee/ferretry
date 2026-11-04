import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgendaItem } from '@ferretry/protocol';
import { Markdown } from '../../../src/components/markdown.tsx';
import { AgendaItemView } from '../../../src/features/agenda/agenda-item-view.tsx';
import type { AgendaVersionsView } from '../../../src/features/agenda/use-item-lifecycle.ts';
import { agendaItem, choices } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { settleUntil } from '../../support/settle.ts';

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
  test('are one switcher that names the open tab, its place and what changed, and a sheet to pick another', async () => {
    setViewport(390);
    await draw();
    expect(root().querySelector('[role="tablist"]')).toBeNull();
    const switcher = one<HTMLButtonElement>('[data-agenda-tab-switch]');
    expect(switcher.textContent).toBe('Where we are now· 1 of 4 · 2 changed');
    expect(switcher.getAttribute('aria-expanded')).toBe('false');
    await interact(() => switcher.click());
    expect(switcher.getAttribute('aria-expanded')).toBe('true');
    const sheet = one('[data-agenda-tab-sheet]', document.body);
    expect(view?.container.contains(sheet)).toBe(false);
    const choices = [...sheet.querySelectorAll<HTMLInputElement>('[data-agenda-tab-choice]')];
    expect(choices.map(choice => [choice.value, choice.checked])).toEqual([
      ['main', true],
      ['body', false],
      ['decisions', false],
      ['risks', false],
    ]);
    expect(sheet.querySelectorAll('[data-agenda-tab-changed]')).toHaveLength(2);
    await interact(() => choices[2]?.click());
    expect(one('[data-agenda-tab-switch]').textContent).toBe('Decisions· 3 of 4 · 2 changed');
    expect(one('[data-agenda-tab-panel]').textContent).toContain('We chose SQLite.');
    // Picking one closes the sheet.
    expect(one('[data-agenda-tab-switch]').getAttribute('aria-expanded')).toBe('false');
  });

  test('the sheet’s close button closes it, and Next moves on without it', async () => {
    setViewport(390);
    await draw();
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-switch]').click());
    await interact(() => one<HTMLButtonElement>('button[aria-label="Close the tabs"]', document.body).click());
    expect(one('[data-agenda-tab-switch]').getAttribute('aria-expanded')).toBe('false');
    await interact(() => one<HTMLButtonElement>('[data-agenda-tab-next]').click());
    expect(one('[data-agenda-part="tabs"]').getAttribute('data-agenda-tab')).toBe('body');
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
    await interact(() => one<HTMLButtonElement>('[data-agenda-diff-toggle]').click());
    await settleUntil(() => root().querySelector('[data-agenda-diff-open-tab]') !== null, 'the diff', interact);
    const open = one<HTMLButtonElement>('[data-agenda-diff-open-tab="risks"]');
    expect(open.getAttribute('aria-label')).toBe('Open the tab Risks');
    await interact(() => open.click());
    expect(selected()).toBe('risks');
  });
});
