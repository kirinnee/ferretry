import { afterEach, describe, expect, test } from 'bun:test';
import { INSIGHTS_COLUMN_CLASS, InsightsFrame } from '../../../app/shell/insights-frame.tsx';
import { interact, mount, type Mounted, must } from '@ferretry/app/testing';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('InsightsFrame', () => {
  test('puts Insights and Warden on one strip, each keeping its own address', async () => {
    const went: string[] = [];
    view = await mount(
      <InsightsFrame current="warden" daemonId="alpha" onNavigate={to => went.push(to)}>
        <p data-page="">Warden page</p>
      </InsightsFrame>,
    );
    expect(view.container.querySelector('[data-insights="warden"] [data-page]')).not.toBeNull();
    const tabs = [...view.container.querySelectorAll<HTMLElement>('[data-insights-tab]')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['Insights', 'Warden']);
    expect(tabs[1]?.getAttribute('aria-current')).toBe('page');
    await interact(() => must(tabs[0], 'Insights').click());
    await interact(() => must(tabs[1], 'Warden').click());
    expect(went).toEqual(['/d/alpha/insights', '/d/alpha/warden']);
  });
});

describe('InsightsFrame geometry', () => {
  test('sets one 16px phone gutter for the tabs and every page under them', async () => {
    view = await mount(
      <InsightsFrame current="insights" daemonId="alpha" onNavigate={() => {}}>
        <p data-page="">Insights page</p>
      </InsightsFrame>,
    );
    const body = must(view.container.querySelector<HTMLElement>('[data-insights-body]'), 'body');
    expect(body.className).toContain('px-4');
    expect(body.className).toContain('sm:px-5');
    expect(body.querySelector('[data-page]')).not.toBeNull();
    expect(INSIGHTS_COLUMN_CLASS).toBe('w-full max-w-[1080px]');
  });
});
