import { describe, expect, it } from 'bun:test';
import { BrowserBar, type BrowserBarProps } from '../../../src/features/browser/browser-bar.tsx';
import type { BrowserChip } from '../../../src/features/browser/browser-bar-model.ts';
import { interact, mount, must, pressKey } from '../../support/dom.ts';

const live: BrowserChip = { kind: 'live', tone: 'ok', label: 'Live', summary: 'Live display.', attention: false };
const ask: BrowserChip = {
  kind: 'ask',
  tone: 'warn',
  label: 'Your turn',
  summary: 'Sign in, then hand it back.',
  attention: true,
};

const step = (label: string, clicks: string[] = []) => ({
  label,
  disabled: false,
  onClick: () => clicks.push(label),
  icon: <i />,
});

const bar = (patch: Partial<BrowserBarProps> = {}): BrowserBarProps => ({
  name: 'app',
  address: 'https://example.test/',
  onAddressChange: () => undefined,
  onAddressFocus: () => undefined,
  onAddressBlur: () => undefined,
  onNavigate: () => undefined,
  navigateDisabled: false,
  chip: live,
  chipDetail: <p data-detail="">the chip detail</p>,
  back: step('Back'),
  forward: step('Forward'),
  reload: step('Reload'),
  menu: <button type="button">Stop browser</button>,
  pages: <nav data-pages="">the pages</nav>,
  working: false,
  menuTitle: 'Browser controls',
  resetKey: 'a',
  ...patch,
});

const find = (root: HTMLElement, selector: string): HTMLElement =>
  must(root.querySelector<HTMLElement>(selector), selector);
const trigger = (root: HTMLElement, name: 'pages' | 'chip' | 'menu'): HTMLElement =>
  find(root, `[data-browser-trigger="${name}"]`);
const has = (root: HTMLElement, selector: string): boolean => root.querySelector(selector) !== null;

describe('BrowserBar', () => {
  it('is one header holding the name, the address, one chip, three steps and a menu — nothing else', async () => {
    const view = await mount(<BrowserBar {...bar()} />);

    expect(view.container.querySelectorAll('[data-browser-bar]')).toHaveLength(1);
    expect(
      [...view.container.querySelectorAll('[data-browser-bar-part]')].map(node =>
        node.getAttribute('data-browser-bar-part'),
      ),
    ).toEqual(['page', 'address', 'chip', 'back', 'forward', 'reload', 'menu']);
    expect(view.container.querySelectorAll('[data-browser-chip]')).toHaveLength(1);
    expect(has(view.container, '[data-detail]')).toBe(false);
    expect(has(view.container, '[data-pages]')).toBe(false);
    await view.unmount();
  });

  it('keeps a held notice in the bar, and opens its detail from the chip only', async () => {
    const view = await mount(<BrowserBar {...bar({ chip: ask })} />);
    const chip = find(view.container, '[data-browser-chip="ask"]');

    expect(chip.hasAttribute('data-attention')).toBe(true);
    expect(chip.getAttribute('data-tone')).toBe('warn');
    expect(chip.getAttribute('aria-label')).toBe('Status: Sign in, then hand it back.');
    await interact(() => chip.click());
    expect(has(view.container, '[data-detail]')).toBe(true);
    await interact(() => chip.click());
    expect(has(view.container, '[data-detail]')).toBe(false);
    await view.unmount();
  });

  it('opens one popover at a time', async () => {
    const view = await mount(<BrowserBar {...bar()} />);

    await interact(() => trigger(view.container, 'menu').click());
    expect(has(view.container, '[data-browser-menu]')).toBe(true);
    await interact(() => trigger(view.container, 'pages').click());
    expect(has(view.container, '[data-browser-menu]')).toBe(false);
    expect(has(view.container, '[data-pages]')).toBe(true);
    await interact(() => trigger(view.container, 'chip').click());
    expect(has(view.container, '[data-pages]')).toBe(false);
    expect(has(view.container, '[data-detail]')).toBe(true);
    await view.unmount();
  });

  it('closes on a choice made in the menu, on Escape, on a tap outside, and when the host re-scopes', async () => {
    const view = await mount(<BrowserBar {...bar()} />);
    const openMenu = () => interact(() => trigger(view.container, 'menu').click());

    await openMenu();
    await interact(() => find(view.container, '[data-browser-menu] button').click());
    expect(has(view.container, '[data-browser-menu]')).toBe(false);

    await openMenu();
    await interact(() => pressKey(document.body, 'Escape'));
    expect(has(view.container, '[data-browser-menu]')).toBe(false);

    await openMenu();
    await interact(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(has(view.container, '[data-browser-menu]')).toBe(false);

    await openMenu();
    await view.render(<BrowserBar {...bar({ resetKey: 'b' })} />);
    expect(has(view.container, '[data-browser-menu]')).toBe(false);
    await view.unmount();
  });

  it('dispatches back, forward and reload, and submits the address on Enter', async () => {
    const clicks: string[] = [];
    const sent: string[] = [];
    const view = await mount(
      <BrowserBar
        {...bar({
          back: step('Back', clicks),
          forward: step('Forward', clicks),
          reload: step('Reload', clicks),
          onNavigate: () => sent.push('go'),
        })}
      />,
    );
    for (const part of ['back', 'forward', 'reload'])
      await interact(() => find(view.container, `[data-browser-bar-part="${part}"]`).click());
    await interact(() => find(view.container, 'button[type="submit"]').click());

    expect(clicks).toEqual(['Back', 'Forward', 'Reload']);
    expect(sent).toEqual(['go']);
    await view.unmount();
  });

  it('is a plain label, not a menu, when the host lists no pages', async () => {
    const view = await mount(<BrowserBar {...bar({ pages: undefined })} />);

    expect(has(view.container, '[data-browser-trigger="pages"]')).toBe(false);
    await view.unmount();
  });

  it('moves only the progress line with the work, so the bar never changes height', async () => {
    const quiet = await mount(<BrowserBar {...bar()} />);
    expect(find(quiet.container, '[data-browser-progress]').className).toContain('opacity-0');
    await quiet.unmount();
    const busy = await mount(<BrowserBar {...bar({ working: true })} />);
    expect(find(busy.container, '[data-browser-progress]').className).toContain('opacity-100');
    await busy.unmount();
  });
});
