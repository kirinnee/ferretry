import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  nextPhoneChip,
  PhoneChipRow,
  type PhoneChipRowProps,
  phoneCloseItems,
  phoneNewTabItems,
} from '../../../../../src/features/workspace/phone/phone-chip-row.tsx';
import { phoneTabOrder } from '../../../../../src/features/workspace/phone/phone-tab.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../../support/dom.ts';

const tabs = phoneTabOrder([
  { id: 't1', kind: 'terminal', label: 'dev', driver: { name: 'hadi' } },
  { id: 'b1', kind: 'browser', label: 'app', driver: null },
  { id: 'f1', kind: 'file', label: 'login.tsx' },
]);

/** The same row as the host draws it: every workspace tab closable. */
const closable = tabs.map(tab =>
  tab.kind === 'chat' || tab.kind === 'console' || tab.kind === 'processes' ? tab : { ...tab, closable: true },
);

const scrolls: ScrollToOptions[] = [];
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
let reduced = false;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(options: ScrollToOptions) {
      scrolls.push(options);
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('reduce') ? reduced : false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  });
});

afterAll(() => {
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
});

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  scrolls.length = 0;
  reduced = false;
});

const row = (props: Partial<PhoneChipRowProps> = {}) => (
  <PhoneChipRow rowId="w" tabs={tabs} activeId="chat" onSelect={() => {}} {...props} />
);

const chip = (container: HTMLElement, id: string): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>(`[data-phone-chip="${id}"]`), `chip ${id}`);

describe('nextPhoneChip', () => {
  it('moves with the arrows and jumps with Home/End, never wrapping', () => {
    expect(nextPhoneChip('ArrowRight', 'chat', tabs)).toBe('console');
    expect(nextPhoneChip('ArrowLeft', 'console', tabs)).toBe('chat');
    expect(nextPhoneChip('ArrowLeft', 'chat', tabs)).toBeNull();
    expect(nextPhoneChip('ArrowRight', 'f1', tabs)).toBeNull();
    expect(nextPhoneChip('Home', 'b1', tabs)).toBe('chat');
    expect(nextPhoneChip('End', 'chat', tabs)).toBe('f1');
    expect(nextPhoneChip('Enter', 'chat', tabs)).toBeNull();
    expect(nextPhoneChip('ArrowRight', 'gone', tabs)).toBeNull();
  });
});

describe('phoneNewTabItems', () => {
  it('offers only the actions it was given, in a fixed order', () => {
    const noop = () => {};
    expect(phoneNewTabItems({}).map(item => item.label)).toEqual([]);
    expect(
      phoneNewTabItems({ onOpenFile: noop, onNewTerminal: noop, onNewBrowser: noop }).map(item => item.label),
    ).toEqual(['New terminal', 'New browser', 'Open file']);
  });
});

describe('phoneCloseItems', () => {
  const noop = () => {};
  const labels = (...args: Parameters<typeof phoneCloseItems>) => phoneCloseItems(...args).map(item => item.label);
  const [chat, , , terminal, browser] = closable as [
    never,
    never,
    never,
    (typeof closable)[number],
    (typeof closable)[number],
  ];

  it('offers nothing for a tab that cannot close, or a host that offers no close', () => {
    expect(labels(chat, closable, { onCloseTab: noop }, true)).toEqual([]);
    expect(labels(browser, closable, {}, true)).toEqual([]);
  });

  it('asks a terminal whether its shell ends too, and offers Close others only from a long-press', () => {
    const all = { onCloseTab: noop, onCloseOthers: noop, onEndTerminal: noop };
    expect(labels(browser, closable, all, false)).toEqual(['Close']);
    expect(labels(browser, closable, all, true)).toEqual(['Close', 'Close others']);
    expect(labels(terminal, closable, all, false)).toEqual(['Close tab', 'End shell']);
    expect(labels(terminal, closable, { onCloseTab: noop }, true)).toEqual(['Close']);
    // Nothing else to close: the agent's tabs never are.
    expect(labels(browser, [chat, browser], all, true)).toEqual(['Close']);
  });

  it('runs the choice against the tab it was opened for', () => {
    const ran: string[] = [];
    const items = phoneCloseItems(
      terminal,
      closable,
      {
        onCloseTab: id => ran.push(`close ${id}`),
        onCloseOthers: id => ran.push(`others ${id}`),
        onEndTerminal: id => ran.push(`end ${id}`),
      },
      true,
    );
    for (const item of items) item.onSelect();
    expect(ran).toEqual(['close t1', 'end t1', 'others t1']);
    expect(items.find(item => item.key === 'end-shell')?.danger).toBe(true);
  });
});

describe('PhoneChipRow', () => {
  it('renders every tab as a real tab with exactly one selected', async () => {
    mounted = await mount(row({ activeId: 'b1' }));
    const list = must(mounted.container.querySelector('[role="tablist"]'), 'tablist');
    const all = [...list.querySelectorAll('[role="tab"]')];
    expect(all.map(node => node.textContent)).toEqual([
      'Chat',
      'Console',
      'Processes',
      'devAGENT, driven by hadi',
      'app',
      'login.tsx',
    ]);
    expect(all.filter(node => node.getAttribute('aria-selected') === 'true').map(node => node.id)).toEqual([
      'w-chip-b1',
    ]);
    expect(chip(mounted.container, 'b1').getAttribute('aria-controls')).toBe('w-panel-b1');
    expect(chip(mounted.container, 'b1').tabIndex).toBe(0);
    expect(chip(mounted.container, 'chat').tabIndex).toBe(-1);
  });

  it('badges only the chips an agent drives', async () => {
    mounted = await mount(row());
    expect(chip(mounted.container, 't1').querySelector('[data-phone-chip-agent]')).not.toBeNull();
    expect(chip(mounted.container, 't1').title).toBe('dev — hadi is driving');
    expect(chip(mounted.container, 'b1').querySelector('[data-phone-chip-agent]')).toBeNull();
    expect(chip(mounted.container, 'b1').title).toBe('app');
  });

  it('selects on click and on arrow keys, moving focus with the selection', async () => {
    const picked: string[] = [];
    mounted = await mount(row({ onSelect: id => picked.push(id) }));
    await interact(() => chip(must(mounted?.container, 'row'), 'b1').click());
    await interact(() => pressKey(chip(must(mounted?.container, 'row'), 'chat'), 'ArrowRight'));
    expect(document.activeElement).toBe(chip(mounted.container, 'console'));
    await interact(() => pressKey(chip(must(mounted?.container, 'row'), 'chat'), 'a'));
    expect(picked).toEqual(['b1', 'console']);
  });

  it('jumps to the active chip first, then glides as it changes', async () => {
    mounted = await mount(row());
    expect(scrolls).toEqual([{ left: 0, behavior: 'auto' }]);
    await mounted.render(row({ activeId: 'f1' }));
    expect(scrolls[1]).toEqual({ left: 0, behavior: 'smooth' });
  });

  it('never animates under reduced motion', async () => {
    reduced = true;
    mounted = await mount(row());
    await mounted.render(row({ activeId: 'f1' }));
    expect(scrolls.map(scroll => scroll.behavior)).toEqual(['auto', 'auto']);
  });

  it('does not scroll toward a tab that is not in the row', async () => {
    mounted = await mount(row({ activeId: 'gone' }));
    expect(scrolls).toEqual([]);
  });

  it('hides ＋ when there is nothing to add', async () => {
    mounted = await mount(row());
    expect(mounted.container.querySelector('[aria-label="New tab"]')).toBeNull();
  });

  it('opens a menu from ＋ that runs the chosen action and closes', async () => {
    const ran: string[] = [];
    mounted = await mount(
      row({
        onNewTerminal: () => ran.push('terminal'),
        onNewBrowser: () => ran.push('browser'),
        onOpenFile: () => ran.push('file'),
      }),
    );
    const plus = must(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]'), 'plus');
    expect(plus.getAttribute('aria-expanded')).toBe('false');
    await interact(() => plus.click());
    expect(plus.getAttribute('aria-expanded')).toBe('true');
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['New terminal', 'New browser', 'Open file']);
    await interact(() => items[1]?.click());
    expect(ran).toEqual(['browser']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('puts a ✕ on the active workspace chip only, and only when the host can close it', async () => {
    mounted = await mount(row({ tabs: closable, activeId: 'b1', onCloseTab: () => {} }));
    const crosses = [...mounted.container.querySelectorAll('[data-phone-chip-close]')];
    expect(crosses.map(node => node.closest('[data-phone-chip]')?.getAttribute('data-phone-chip'))).toEqual(['b1']);
    expect(chip(mounted.container, 'b1').getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(chip(mounted.container, 'chat').getAttribute('aria-keyshortcuts')).toBeNull();
    await mounted.render(row({ tabs: closable, activeId: 'chat', onCloseTab: () => {} }));
    expect(mounted.container.querySelector('[data-phone-chip-close]')).toBeNull();
    await mounted.render(row({ tabs: closable, activeId: 'b1' }));
    expect(mounted.container.querySelector('[data-phone-chip-close]')).toBeNull();
  });

  it('closes a page or file at once from ✕ or Delete, without selecting it', async () => {
    const ran: string[] = [];
    const props = {
      tabs: closable,
      onCloseTab: (id: string) => ran.push(`close ${id}`),
      onSelect: (id: string) => ran.push(`select ${id}`),
    };
    mounted = await mount(row({ ...props, activeId: 'f1' }));
    const cross = must(chip(mounted.container, 'f1').querySelector<HTMLElement>('[data-phone-chip-close]'), '✕');
    await interact(() => cross.click());
    await interact(() => pressKey(chip(must(mounted?.container, 'row'), 'f1'), 'Delete'));
    // Delete on an agent tab is just a key: nothing closes.
    await interact(() => pressKey(chip(must(mounted?.container, 'row'), 'chat'), 'Delete'));
    expect(ran).toEqual(['close f1', 'close f1']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('asks under a terminal chip whether to end its shell, and closes it outright when it cannot', async () => {
    const ran: string[] = [];
    mounted = await mount(
      row({
        tabs: closable,
        activeId: 't1',
        onCloseTab: id => ran.push(`close ${id}`),
        onEndTerminal: id => ran.push(`end ${id}`),
      }),
    );
    await interact(() =>
      must(
        chip(must(mounted?.container, 'row'), 't1').querySelector<HTMLElement>('[data-phone-chip-close]'),
        '✕',
      ).click(),
    );
    expect(must(document.querySelector('[role="menu"]'), 'menu').getAttribute('aria-label')).toBe('Close dev');
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['Close tabkeeps running', 'End shellstops its process']);
    await interact(() => items[1]?.click());
    expect(ran).toEqual(['end t1']);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await mounted.render(row({ tabs: closable, activeId: 't1', onCloseTab: id => ran.push(`close ${id}`) }));
    await interact(() =>
      must(
        chip(must(mounted?.container, 'row'), 't1').querySelector<HTMLElement>('[data-phone-chip-close]'),
        '✕',
      ).click(),
    );
    expect(ran).toEqual(['end t1', 'close t1']);
  });

  it('opens Close / Close others from a long-press on any workspace chip, and leaves the agent tabs alone', async () => {
    const ran: string[] = [];
    mounted = await mount(
      row({ tabs: closable, onCloseTab: id => ran.push(`close ${id}`), onCloseOthers: id => ran.push(`others ${id}`) }),
    );
    const press = (id: string): MouseEvent => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 });
      chip(must(mounted?.container, 'row'), id).dispatchEvent(event);
      return event;
    };
    let chatPress: MouseEvent | null = null;
    await interact(() => {
      chatPress = press('chat');
    });
    expect((chatPress as MouseEvent | null)?.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await interact(() => press('b1'));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(['Close', 'Close others']);
    await interact(() => items[1]?.click());
    expect(ran).toEqual(['others b1']);
  });
});

describe('PhoneChipRow — agent-opened surfaces', () => {
  const fresh = phoneTabOrder([
    { id: 't1', kind: 'terminal', label: 'dev', fresh: true },
    { id: 'b1', kind: 'browser', label: 'app', asked: true, fresh: true },
    { id: 'f1', kind: 'file', label: 'login.tsx' },
  ]);

  it('dots a tab the agent added, and badges the one it handed over as YOUR TURN instead', async () => {
    mounted = await mount(row({ tabs: fresh }));
    const dev = chip(mounted.container, 't1');
    const app = chip(mounted.container, 'b1');
    expect(dev.getAttribute('data-fresh')).toBe('true');
    expect(dev.querySelector('[data-phone-chip-new]')).not.toBeNull();
    expect(dev.querySelector('[data-phone-chip-ask]')).toBeNull();
    expect(app.getAttribute('data-asked')).toBe('true');
    expect(app.getAttribute('data-fresh')).toBe('false');
    expect(app.querySelector('[data-phone-chip-new]')).toBeNull();
    expect(app.querySelector('[data-phone-chip-ask]')?.textContent).toContain('YOUR TURN');
    expect(chip(mounted.container, 'f1').getAttribute('data-asked')).toBe('false');
  });

  it('offers a closed agent surface back in ＋, after the create commands', async () => {
    const ran: string[] = [];
    expect(
      phoneNewTabItems({
        onNewTerminal: () => {},
        reopen: [
          { key: 'r1', label: 'Reopen terminal dev', onSelect: () => ran.push('r1') },
          { key: 'r2', label: 'Reopen page app', onSelect: () => ran.push('r2') },
        ],
      }).map(item => [item.label, item.separatorBefore === true]),
    ).toEqual([
      ['New terminal', false],
      ['Reopen terminal dev', true],
      ['Reopen page app', false],
    ]);
    mounted = await mount(
      row({ reopen: [{ key: 'r1', label: 'Reopen terminal dev', onSelect: () => ran.push('r1') }] }),
    );
    await interact(() =>
      must(mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="New tab"]'), 'plus').click(),
    );
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    await interact(() => items[0]?.click());
    expect(items.map(item => item.textContent)).toEqual(['Reopen terminal dev']);
    expect(ran).toEqual(['r1']);
  });
});
