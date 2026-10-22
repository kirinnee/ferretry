import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import { ConnectionDrops, connectionDropsSummary } from '../../../../src/features/settings/connection-drops.tsx';
import { performanceSettingsTab } from '../../../../src/features/settings/performance-settings.tsx';
import { type CarrierDropEnvironment, CarrierDropLog } from '../../../../src/lib/carrier-drops.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});
const beta = daemonConnection({
  daemonId: 'beta',
  baseUrl: 'https://beta.example.test',
  deviceId: 'fy_device_id_beta000000000000000000',
});

const clock = { now: Date.UTC(2026, 9, 22, 7, 0, 0), hiddenFor: undefined as number | undefined };
const environment: CarrierDropEnvironment = {
  now: () => clock.now,
  hiddenFor: () => clock.hiddenFor,
  online: () => true,
  network: () => undefined,
};
const END = { code: 1006, reason: '', livedMs: 90_000, lastHeardMs: 1_000 };

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

describe('the connection drops panel', () => {
  it('should say there is nothing to report before anything dropped', async () => {
    // Arrange
    const drops = new CarrierDropLog(environment, memory());

    // Act
    const shown = await mount(<ConnectionDrops connection={alpha} drops={drops} />);

    // Assert
    expect(shown.container.querySelector('[data-connection-drops-summary]')?.textContent).toBe(
      'No dropped connections recorded on this device.',
    );
    expect(shown.container.querySelector('[data-connection-drops-copy]')).toBeNull();
  });

  it('should list this machine’s drops newest first, live, copy them, and clear only this machine’s', async () => {
    // Arrange
    const drops = new CarrierDropLog(environment, memory());
    const copied: string[] = [];
    const shown = await mount(
      <ConnectionDrops connection={alpha} drops={drops} write={async text => void copied.push(text)} />,
    );

    // Act — two drops for this machine, one for another, the first hidden and reconnected.
    await interact(() => {
      clock.hiddenFor = 120_000;
      drops.dropped(alpha.daemonId, 'tunnel', 'stream', END);
      clock.now += 400;
      drops.reconnected(alpha.daemonId);
      clock.hiddenFor = undefined;
      clock.now += 60_000;
      drops.dropped(alpha.daemonId, 'tunnel', 'requests', { ...END, code: 4408 });
      drops.dropped(beta.daemonId, 'relay', 'requests', END);
    });

    // Assert
    const items = [...shown.container.querySelectorAll('li')].map(item => item.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('tunnel requests · 4408 no heartbeat answer');
    expect(items[1]).toContain('page hidden 2 min');
    expect(items[1]).toContain('back in 400 ms');
    expect(shown.container.querySelector('[data-connection-drops-summary]')?.textContent).toBe(
      '2 dropped connections · 1 while the app was hidden · usually back in 0.4 s',
    );

    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-connection-drops-copy]'), 'copy').click(),
    );
    expect(copied[0]?.split('\n')[1]).toBe('  tunnel: 2 (1006×1, 4408×1)');

    await interact(() =>
      must(shown.container.querySelector<HTMLButtonElement>('[data-connection-drops-clear]'), 'clear').click(),
    );
    expect(shown.container.querySelectorAll('li')).toHaveLength(0);
    expect(drops.snapshot().map(drop => drop.daemonId)).toEqual([beta.daemonId]);
  });

  it('should sit under the recorder on the Performance tab when the app has a drop log', async () => {
    // Arrange
    const drops = new CarrierDropLog(environment, memory());
    const tab = performanceSettingsTab(
      async () => {
        throw new Error('not asked');
      },
      undefined,
      drops,
    );

    // Act
    const shown = await mount(<tab.Surface connection={alpha} />);

    // Assert
    expect(shown.container.querySelector('[data-performance-record]')).not.toBeNull();
    expect(shown.container.querySelector('[data-connection-drops]')).not.toBeNull();
    expect(connectionDropsSummary([])).toBe('No dropped connections recorded on this device.');
  });
});
