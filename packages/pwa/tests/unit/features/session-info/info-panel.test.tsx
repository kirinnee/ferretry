/**
 * The Info panel's chrome: the title line, the six tabs (with a Signals badge), the shown tab's body,
 * and — on a phone — the half/full control. Presentational: every tab's body is the host's render prop.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { INFO_TABS, type InfoTab } from '../../../../src/features/session-info/info-model.ts';
import { InfoPanel, type InfoPanelProps } from '../../../../src/features/session-info/info-panel.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const render = Object.fromEntries(INFO_TABS.map(tab => [tab, () => <p>{`${tab} body`}</p>])) as Record<
  InfoTab,
  () => ReactNode
>;

const show = async (overrides: Partial<InfoPanelProps> = {}) => {
  const tabs: InfoTab[] = [];
  const closes: boolean[] = [];
  mounted = await mount(
    <InfoPanel
      name="Hadi"
      onClose={() => closes.push(true)}
      onTabChange={tab => tabs.push(tab)}
      render={render}
      tab="overview"
      {...overrides}
    />,
  );
  return { root: mounted.container, tabs, closes };
};

describe('InfoPanel — head and tabs', () => {
  it('titles the panel Info, names the ferret, and draws every tab', async () => {
    const { root } = await show();
    expect(root.querySelector('.fy-info__title')?.textContent).toBe('Info');
    expect(root.querySelector('.fy-info__name')?.textContent).toBe('Hadi');
    expect([...root.querySelectorAll('[role="tab"]')].map(button => button.textContent)).toEqual([
      'Overview',
      'Runtime',
      'Usage',
      'Context',
      'Signals',
      'Surfaces',
    ]);
    expect(root.querySelector('[data-info-body="overview"]')?.textContent).toBe('overview body');
  });

  it('switches tabs and renders only the shown tab’s body', async () => {
    const { root, tabs } = await show();
    const runtimeTab = must(
      [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Runtime'),
      'the Runtime tab',
    );
    await interact(() => runtimeTab.click());
    expect(tabs).toEqual(['runtime']);
  });

  it('carries no Signals badge by default, and the open count once there is one', async () => {
    const { root } = await show();
    expect(root.querySelector('[data-info-signals-count]')).toBeNull();

    await mounted?.unmount();
    mounted = undefined;
    const withBadge = await show({ openSignals: 2 });
    const badge = must(withBadge.root.querySelector('[data-info-signals-count]'), 'the badge');
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('aria-label')).toBe('2 open');
  });
});

describe('InfoPanel — close', () => {
  it('closes through its × button', async () => {
    const { root, closes } = await show();
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-close]'), 'close').click());
    expect(closes).toEqual([true]);
  });
});

describe('InfoPanel — phone sheet size', () => {
  it('draws no size control on a desktop panel (no sheetSize)', async () => {
    const { root } = await show();
    expect(root.querySelector('[data-info-size]')).toBeNull();
  });

  it('expands from half to full and shrinks back, on a phone sheet', async () => {
    const sizes: string[] = [];
    const { root } = await show({ sheetSize: 'half', onSheetSizeChange: size => sizes.push(size) });
    const control = must(root.querySelector<HTMLButtonElement>('[data-info-size]'), 'the size control');
    expect(control.getAttribute('data-info-size')).toBe('half');
    expect(control.getAttribute('aria-label')).toBe('Expand Info to full height');
    await interact(() => control.click());
    expect(sizes).toEqual(['full']);

    await mounted?.unmount();
    mounted = undefined;
    const full = await show({ sheetSize: 'full', onSheetSizeChange: size => sizes.push(size) });
    const shrink = must(full.root.querySelector<HTMLButtonElement>('[data-info-size]'), 'the size control');
    expect(shrink.getAttribute('aria-label')).toBe('Shrink Info to half height');
    await interact(() => shrink.click());
    expect(sizes).toEqual(['full', 'half']);
  });
});

describe('InfoPanel — titleId', () => {
  it('stamps the given id on the title, for the host’s aria-labelledby', async () => {
    const { root } = await show({ titleId: 'info-title-1' });
    expect(root.querySelector('.fy-info__title')?.id).toBe('info-title-1');
  });
});
