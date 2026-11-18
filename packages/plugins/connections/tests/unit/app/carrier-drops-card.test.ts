/**
 * THE "CONNECTION DROPS ON THIS DEVICE" CARD (v4's Settings › Machine › Performance card, e2-gaps line 27): it lists
 * what the browser's drop log kept, says so plainly when nothing was lost, and sits in this device's Connection panel.
 */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CarrierDropsCard,
  carrierDropsSummary,
  NO_CARRIER_DROPS,
} from '../../../app/features/carrier/carrier-drops-card.tsx';
import {
  DeviceConnectionPanel,
  type DeviceConnectionPorts,
} from '../../../app/features/carrier/device-connection-panel.tsx';
import { CarrierDropLog } from '../../../app/lib/carrier-drops.ts';
import { CarrierPreferenceStore } from '../../../app/lib/carrier-preference.ts';

const MACHINE = 'fy_daemon_machineOne';
const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};
const logWith = (count: number): CarrierDropLog => {
  let now = Date.UTC(2026, 10, 18, 7, 0, 0);
  const log = new CarrierDropLog(
    { now: () => now, hiddenFor: () => undefined, online: () => true, network: () => undefined },
    memory(),
  );
  for (let at = 0; at < count; at += 1) {
    log.dropped(MACHINE, 'relay', 'requests', {
      code: 1006,
      reason: `cut ${String(at)}`,
      livedMs: 125_000,
      lastHeardMs: 3_200,
    });
    now += 60_000;
  }
  return log;
};

test('a device that lost nothing says so, with no Copy button', () => {
  const html = renderToStaticMarkup(
    createElement(CarrierDropsCard, { log: logWith(0), daemonId: MACHINE, machine: 'studio' }),
  );
  expect(html).toContain('Connection drops on this device');
  expect(html).toContain(NO_CARRIER_DROPS);
  expect(html).not.toContain('Copy report');
});

test('the drops it kept are listed newest first, as the line Copy report carries', () => {
  const log = logWith(2);
  const html = renderToStaticMarkup(createElement(CarrierDropsCard, { log, daemonId: MACHINE, machine: 'studio' }));
  const [older] = log.snapshot();
  expect(html).toContain('Copy report');
  expect(html).toContain('lived 2 min');
  expect(html).toContain('cut 1');
  expect(html.indexOf('cut 1')).toBeLessThan(html.indexOf('cut 0'));
  expect(older?.reason).toBe('cut 0');
});

test('a long log lists only the newest twenty and says where the rest is', () => {
  const html = renderToStaticMarkup(
    createElement(CarrierDropsCard, { log: logWith(25), daemonId: MACHINE, machine: 'studio' }),
  );
  expect(html.match(/<li /gu)).toHaveLength(20);
  expect(html).toContain('20 newest of 25 shown');
});

test("this device's Connection panel carries the card when a log is given, and none without one", () => {
  const ports: DeviceConnectionPorts = {
    daemons: {
      snapshot: () => ({ daemons: [{ daemon: MACHINE, machine: 'studio' }] }) as never,
      subscribe: () => () => undefined,
    },
    preferences: new CarrierPreferenceStore(),
    webrtc: true,
  };
  const withLog = renderToStaticMarkup(createElement(DeviceConnectionPanel, { ...ports, drops: logWith(1) }));
  expect(withLog).toContain(`data-carrier-drops="${MACHINE}"`);
  const without = renderToStaticMarkup(createElement(DeviceConnectionPanel, ports));
  expect(without).not.toContain('data-carrier-drops');
});

test('a card names its machine and lists only the drops of that machine, never of another', () => {
  const log = logWith(2);
  log.dropped('fy_daemon_machineTwo', 'direct', 'stream', {
    code: 1011,
    reason: 'elsewhere',
    livedMs: 5_000,
    lastHeardMs: 100,
  });
  const mine = renderToStaticMarkup(createElement(CarrierDropsCard, { log, daemonId: MACHINE, machine: 'studio' }));
  expect(mine).toContain('Connection drops on this device · studio');
  expect(mine).not.toContain('elsewhere');
  const other = renderToStaticMarkup(
    createElement(CarrierDropsCard, { log, daemonId: 'fy_daemon_machineTwo', machine: 'laptop' }),
  );
  expect(other).toContain('elsewhere');
  expect(other).not.toContain('cut 0');
});

test('the summary line counts the drops, those while hidden and the usual time back', () => {
  let now = Date.UTC(2026, 10, 18, 7, 0, 0);
  let hidden: number | undefined;
  const log = new CarrierDropLog(
    { now: () => now, hiddenFor: () => hidden, online: () => true, network: () => undefined },
    memory(),
  );
  log.dropped(MACHINE, 'relay', 'requests', { code: 1006, reason: 'a', livedMs: 1, lastHeardMs: 1 });
  now += 4_000;
  log.reconnected(MACHINE);
  hidden = 30_000;
  log.dropped(MACHINE, 'relay', 'requests', { code: 1006, reason: 'b', livedMs: 1, lastHeardMs: 1 });
  expect(carrierDropsSummary(log.snapshot())).toBe('2 dropped · 1 while hidden · usually back in 4.0 s');
  expect(carrierDropsSummary(log.snapshot().slice(1))).toBe('1 dropped · 1 while hidden');
});

test('Clear forgets the drops of this machine and leaves those of another', () => {
  const log = logWith(2);
  log.dropped('fy_daemon_machineTwo', 'direct', 'stream', {
    code: 1011,
    reason: 'elsewhere',
    livedMs: 5_000,
    lastHeardMs: 100,
  });
  const html = renderToStaticMarkup(createElement(CarrierDropsCard, { log, daemonId: MACHINE, machine: 'studio' }));
  expect(html).toContain('data-carrier-drops-clear=""');
  log.clearDaemon(MACHINE);
  expect(log.snapshot().map(drop => drop.daemonId)).toEqual(['fy_daemon_machineTwo']);
});
