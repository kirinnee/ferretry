import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { InsightsFrame } from '../../src/shell/insights-frame.tsx';
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
});
