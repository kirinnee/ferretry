import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  nextPhoneChip,
  PhoneChipRow,
  type PhoneChipRowProps,
  phoneNewTabItems,
} from '../../../../../src/features/workspace/phone/phone-chip-row.tsx';
import { phoneTabOrder } from '../../../../../src/features/workspace/phone/phone-tab.ts';
import { interact, type Mounted, mount, must, pressKey } from '../../../../support/dom.ts';

const tabs = phoneTabOrder([
  { id: 't1', kind: 'terminal', label: 'dev', driver: { name: 'hadi' } },
  { id: 'b1', kind: 'browser', label: 'app', driver: null },
  { id: 'f1', kind: 'file', label: 'login.tsx' },
]);

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

describe('PhoneChipRow', () => {
  it('renders every tab as a real tab with exactly one selected', async () => {
    mounted = await mount(row({ activeId: 'b1' }));
    const list = must(mounted.container.querySelector('[role="tablist"]'), 'tablist');
    const all = [...list.querySelectorAll('[role="tab"]')];
    expect(all.map(node => node.textContent)).toEqual([
      'Chat',
      'Console',
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
});
