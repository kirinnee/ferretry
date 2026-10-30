import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { INSIGHTS_COLUMN_CLASS, InsightsFrame } from '../../src/shell/insights-frame.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('InsightsFrame', () => {
  test('puts Analytics, Warden and Learning on one strip, each keeping its own address', async () => {
    const went: string[] = [];
    view = await mount(
      <InsightsFrame current="warden" daemonId={'alpha' as DaemonId} onNavigate={to => went.push(to)}>
        <p data-page="">Warden page</p>
      </InsightsFrame>,
    );
    expect(view.container.querySelector('[data-insights="warden"] [data-page]')).not.toBeNull();
    const tabs = [...view.container.querySelectorAll<HTMLElement>('[data-insights-tab]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Analytics', 'Warden', 'Learning']);
    expect(tabs[1]?.getAttribute('aria-current')).toBe('page');
    await interact(() => tabs[0]?.click());
    await interact(() => must(tabs[2], 'Learning').click());
    expect(went).toEqual(['/d/alpha/analytics', '/d/alpha/learning']);
  });

  test('carries the theme switch at the right end of the same strip, not on a bar of its own', async () => {
    view = await mount(
      <InsightsFrame current="analytics" daemonId={'alpha' as DaemonId} onNavigate={() => {}}>
        <p data-page="">Analytics page</p>
      </InsightsFrame>,
    );
    const switches = view.container.querySelectorAll<HTMLElement>('[data-page-theme-switch]');
    expect(switches).toHaveLength(1);
    const strip = must(switches[0]?.parentElement, 'strip');
    expect(strip.lastElementChild).toBe(switches[0] ?? null);
    expect(strip.querySelector('[data-insights-tab]')).not.toBeNull();
  });
});

describe('InsightsFrame geometry', () => {
  test('sets one 16px phone gutter for the tabs and every page under them', async () => {
    view = await mount(
      <InsightsFrame current="learning" daemonId={'alpha' as DaemonId} onNavigate={() => {}}>
        <p data-page="">Learning page</p>
      </InsightsFrame>,
    );
    const body = must(view.container.querySelector<HTMLElement>('[data-insights-body]'), 'body');
    expect(body.className).toContain('px-4');
    expect(body.className).toContain('sm:px-5');
    expect(body.querySelector('[data-page]')).not.toBeNull();
    expect(INSIGHTS_COLUMN_CLASS).toBe('w-full max-w-[1080px]');
  });
});
