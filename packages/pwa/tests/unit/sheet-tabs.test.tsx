import { describe, expect, it } from 'bun:test';
import { SheetTabs, type SheetTabSpec, nextDetailsTab, sheetPanelId, sheetTabId } from '../../src/shell/sheet-tabs.tsx';
import { interact, mount, pressKey } from '../support/dom.ts';

type Section = 'identity' | 'runtime' | 'progress' | 'budget';

const ORDER: readonly Section[] = ['identity', 'runtime', 'progress', 'budget'];

const TABS: readonly SheetTabSpec<Section>[] = [
  { key: 'identity', label: 'Identity' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'progress', label: 'Progress' },
  { key: 'budget', label: 'Budget' },
];

const buttonsOf = (container: HTMLElement): HTMLButtonElement[] => [...container.querySelectorAll('button')];

const strip = (props: {
  current: Section;
  onChange?: (key: Section) => void;
  tabs?: readonly SheetTabSpec<Section>[];
  label?: string;
}) => (
  <SheetTabs
    sheetId="sheet-1"
    tabs={props.tabs ?? TABS}
    current={props.current}
    order={ORDER}
    onChange={props.onChange ?? (() => {})}
    {...(props.label ? { label: props.label } : {})}
  />
);

describe('nextDetailsTab', () => {
  it('steps forward and backward with wrap at both ends', () => {
    expect(nextDetailsTab('ArrowRight', 'identity', ORDER)).toBe('runtime');
    expect(nextDetailsTab('ArrowDown', 'budget', ORDER)).toBe('identity');
    expect(nextDetailsTab('ArrowLeft', 'runtime', ORDER)).toBe('identity');
    expect(nextDetailsTab('ArrowUp', 'identity', ORDER)).toBe('budget');
  });

  it('jumps to the ends on Home and End', () => {
    expect(nextDetailsTab('Home', 'progress', ORDER)).toBe('identity');
    expect(nextDetailsTab('End', 'identity', ORDER)).toBe('budget');
  });

  it('leaves any other key, and any tab outside the order, to the browser', () => {
    expect(nextDetailsTab('Enter', 'identity', ORDER)).toBeNull();
    expect(nextDetailsTab('ArrowRight', 'identity', [])).toBeNull();
  });
});

describe('sheet tab ids', () => {
  it('derive from the sheet instance so two retained panes cannot collide', () => {
    expect(sheetTabId('sheet-a', 'identity')).toBe('sheet-a-tab-identity');
    expect(sheetPanelId('sheet-a', 'identity')).toBe('sheet-a-tabpanel-identity');
    expect(sheetTabId('sheet-b', 'identity')).not.toBe(sheetTabId('sheet-a', 'identity'));
  });
});

describe('SheetTabs', () => {
  it('is a real WAI-ARIA tablist with a roving tabindex and wired-up panel ids', async () => {
    const mounted = await mount(strip({ current: 'runtime' }));
    const list = mounted.container.querySelector('[role="tablist"]') as HTMLElement;
    const tabs = buttonsOf(mounted.container);

    expect(list.getAttribute('aria-label')).toBe('Session details sections');
    expect(tabs.map(tab => tab.getAttribute('role'))).toEqual(['tab', 'tab', 'tab', 'tab']);
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
    expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(tabs.map(tab => tab.id)).toEqual(ORDER.map(key => sheetTabId('sheet-1', key)));
    expect(tabs.map(tab => tab.getAttribute('aria-controls'))).toEqual(ORDER.map(key => sheetPanelId('sheet-1', key)));
    // Equal-width columns: a strip that never needs scrolling.
    expect(tabs.every(tab => tab.className.includes('flex-1'))).toBe(true);

    await mounted.unmount();
  });

  it('takes a caller label, because the strip is not always the session sheet', async () => {
    const mounted = await mount(strip({ current: 'identity', label: 'Warden sections' }));

    expect(mounted.container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Warden sections');

    await mounted.unmount();
  });

  it('reports a click on another tab and stays silent on the selected one', async () => {
    const picked: Section[] = [];
    const mounted = await mount(strip({ current: 'identity', onChange: key => picked.push(key) }));
    const tabs = buttonsOf(mounted.container);

    await interact(() => tabs[2]?.dispatchEvent(new Event('click', { bubbles: true })));
    await interact(() => tabs[0]?.dispatchEvent(new Event('click', { bubbles: true })));

    expect(picked).toEqual(['progress']);

    await mounted.unmount();
  });

  it('moves selection with the arrow keys and swallows the key it handled', async () => {
    const picked: Section[] = [];
    const mounted = await mount(strip({ current: 'identity', onChange: key => picked.push(key) }));
    const tabs = buttonsOf(mounted.container);
    const handled = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    const ignored = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });

    await interact(() => tabs[0]?.dispatchEvent(handled));
    await interact(() => tabs[0]?.dispatchEvent(ignored));

    expect(picked).toEqual(['runtime']);
    expect(handled.defaultPrevented).toBe(true);
    expect(ignored.defaultPrevented).toBe(false);

    await mounted.unmount();
  });

  it('carries focus to the newly selected tab when the strip already had focus', async () => {
    const mounted = await mount(strip({ current: 'identity' }));
    const tabs = buttonsOf(mounted.container);

    tabs[0]?.focus();
    await mounted.render(strip({ current: 'progress' }));

    expect(document.activeElement).toBe(tabs[2] as HTMLButtonElement);

    await mounted.unmount();
  });

  it('never steals focus from a panel or anything else outside the strip', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const mounted = await mount(strip({ current: 'identity' }));

    outside.focus();
    await mounted.render(strip({ current: 'progress' }));

    expect(document.activeElement).toBe(outside);

    await mounted.unmount();
    outside.remove();
  });

  it('focuses the selection an arrow key just made, on the next frame', async () => {
    let current: Section = 'identity';
    const mounted = await mount(
      strip({
        current,
        onChange: key => {
          current = key;
        },
      }),
    );

    buttonsOf(mounted.container)[0]?.focus();
    await interact(() => pressKey(buttonsOf(mounted.container)[0] as HTMLButtonElement, 'ArrowRight'));
    await mounted.render(strip({ current }));
    await interact(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));

    expect(document.activeElement).toBe(buttonsOf(mounted.container)[1] as HTMLButtonElement);

    await mounted.unmount();
  });

  it('forgets a tab that leaves the strip instead of holding a detached node', async () => {
    const mounted = await mount(strip({ current: 'identity' }));
    const shorter = TABS.slice(0, 2);

    await mounted.render(strip({ current: 'runtime', tabs: shorter }));

    expect(buttonsOf(mounted.container)).toHaveLength(2);

    // The strip still selects by identity after the removal, not by index.
    await mounted.render(strip({ current: 'identity', tabs: shorter }));

    expect(buttonsOf(mounted.container)[0]?.getAttribute('aria-selected')).toBe('true');

    await mounted.unmount();
  });

  it('renders a supplied icon alongside the label', async () => {
    const mounted = await mount(
      strip({ current: 'identity', tabs: [{ key: 'identity', label: 'Identity', icon: <svg role="presentation" /> }] }),
    );

    expect(mounted.container.querySelectorAll('svg')).toHaveLength(1);

    await mounted.unmount();
  });
});
