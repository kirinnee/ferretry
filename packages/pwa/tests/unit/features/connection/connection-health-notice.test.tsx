import '../../../support/dom.ts';
import { describe, expect, it } from 'bun:test';
import {
  ConnectionHealthNotice,
  ConnectionHealthNoticeView,
} from '../../../../src/features/connection/connection-health-notice.tsx';
import {
  type ConnectionHealth,
  type ConnectionHealthState,
  RECONNECTING_GRACE_MS,
} from '../../../../src/lib/connection-health.ts';
import { type DaemonId, daemonId } from '../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../support/dom.ts';

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const MACHINE = 'workbench';
const DAEMON = daemonId('workbench-daemon');

const reconnecting = (overrides: Partial<Reconnecting> = {}): Reconnecting => ({
  kind: 'reconnecting',
  since: NOW - 12_000,
  attempt: 1,
  nextAttemptAt: NOW + 4_000,
  failures: [
    { label: 'Direct', detail: 'direct was not reachable (1006)' },
    { label: 'Hosted relay', detail: 'the browser could not open a connection to the hosted relay (1006)' },
  ],
  cause: 'relay-unreachable',
  stalled: false,
  ...overrides,
});

const view = (state: ConnectionHealthState, onRetryNow: () => void = () => {}) => (
  <ConnectionHealthNoticeView state={state} machineName={MACHINE} now={NOW} onRetryNow={onRetryNow} />
);

const pill = (): HTMLButtonElement | null => document.querySelector('[data-connection-pill]');
const sheet = (): HTMLElement | null => document.querySelector('[data-connection-sheet]');
const sheetOpen = (): boolean => document.querySelector('[role="dialog"][aria-modal="true"]') !== null;

describe('ConnectionHealthNoticeView', () => {
  it('says nothing about an outage younger than the grace, then the pill once it is older', async () => {
    const shown = await mount(view(reconnecting({ since: NOW - RECONNECTING_GRACE_MS + 1 })));
    try {
      expect(pill()).toBeNull();
      await shown.render(view(reconnecting({ since: NOW - RECONNECTING_GRACE_MS })));
      expect(must(pill(), 'the pill').textContent).toContain('Reconnecting…');
    } finally {
      await shown.unmount();
    }
  });

  it('shows the stall banner whatever the outage age says', async () => {
    const shown = await mount(view(reconnecting({ since: NOW, stalled: true })));
    try {
      expect(shown.container.querySelector('[data-connection-stall]')).not.toBeNull();
    } finally {
      await shown.unmount();
    }
  });

  it('shows nothing before anything is measured, or while connected', async () => {
    const shown = await mount(view({ kind: 'unknown' }));
    try {
      expect(pill()).toBeNull();
      expect(shown.container.querySelector('[data-connection-stall]')).toBeNull();
      await shown.render(view({ kind: 'connected' }));
      expect(pill()).toBeNull();
      const region = must(shown.container.querySelector('[role="status"]'), 'the live region');
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.textContent).toBe('');
    } finally {
      await shown.unmount();
    }
  });

  it('is one calm line while reconnecting: a countdown first, then the attempt', async () => {
    const shown = await mount(view(reconnecting()));
    try {
      const button = must(pill(), 'the pill');
      expect(button.tagName).toBe('BUTTON');
      expect(button.textContent).toBe('Reconnecting…· retrying in 4s');
      expect(button.closest('[role="status"]')).not.toBeNull();
      // The theme's busy mark, which pulses rather than turns under reduced motion (spinner.css).
      expect(button.querySelector('svg')?.getAttribute('class')).toBe('fy-spinner');
      await shown.render(view(reconnecting({ attempt: 3 })));
      expect(must(pill(), 'the pill').textContent).toBe('Reconnecting…· attempt 3');
      await shown.render(view(reconnecting({ nextAttemptAt: null })));
      expect(must(pill(), 'the pill').textContent).toBe('Reconnecting…');
      // The walk's own words never reach the page outside the sheet.
      expect(shown.container.textContent).not.toContain('1006');
    } finally {
      await shown.unmount();
    }
  });

  it('opens the details sheet: plain state, duration, attempts, one line per carrier', async () => {
    const retries: string[] = [];
    const state = reconnecting({
      attempt: 2,
      failures: [
        { label: 'Direct', detail: 'direct was not reachable (1006)' },
        { label: 'Hosted relay', detail: 'relay closed (1006)' },
        { label: 'Direct', detail: 'direct was not reachable (1006)' },
      ],
    });
    const shown = await mount(view(state, () => retries.push('retry')));
    try {
      const button = must(pill(), 'the pill');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(sheetOpen()).toBe(false);
      await interact(() => button.click());
      expect(sheetOpen()).toBe(true);
      expect(must(pill(), 'the pill').getAttribute('aria-expanded')).toBe('true');
      const body = must(sheet(), 'the sheet');
      expect(body.textContent).toContain(`Trying to reach ${MACHINE} again.`);
      expect(must(body.querySelector('[data-connection-meta]'), 'the meta line').textContent).toBe(
        'Lost 12 seconds ago · 2 automatic attempts',
      );
      const carriers = [...body.querySelectorAll('[data-connection-carrier]')].map(row =>
        row.getAttribute('data-connection-carrier'),
      );
      expect(carriers).toEqual(['Direct', 'Hosted relay']);
      await interact(() => must(body.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry now').click());
      expect(retries).toEqual(['retry']);
      await interact(() =>
        must(document.querySelector<HTMLButtonElement>('[aria-label="Close connection details"]'), 'close').click(),
      );
      expect(sheetOpen()).toBe(false);
    } finally {
      await shown.unmount();
    }
  });

  it('leaves out the technical section when no carrier reported, and says Connected after recovery', async () => {
    const shown = await mount(view(reconnecting({ failures: [] })));
    try {
      await interact(() => must(pill(), 'the pill').click());
      expect(must(sheet(), 'the sheet').querySelector('dl')).toBeNull();
      await shown.render(view({ kind: 'connected' }));
      expect(sheetOpen()).toBe(true);
      expect(must(sheet(), 'the sheet').textContent).toContain(`Connected to ${MACHINE}.`);
      expect(must(sheet(), 'the sheet').querySelector('[data-connection-retry]')).toBeNull();
    } finally {
      await shown.unmount();
    }
  });

  it('becomes a plain banner only once stalled, with the cause’s words and both actions', async () => {
    const retries: string[] = [];
    const shown = await mount(
      view(reconnecting({ stalled: true, cause: 'daemon-unreachable' }), () => retries.push('x')),
    );
    try {
      expect(pill()).toBeNull();
      const banner = must(shown.container.querySelector('[data-connection-stall]'), 'the banner');
      expect(banner.getAttribute('data-connection-stall')).toBe('daemon-unreachable');
      expect(banner.textContent).toContain(`${MACHINE} is asleep or its daemon is stopped`);
      expect(banner.textContent).toContain('Wake the machine, or start its daemon by running fyd on it.');
      expect(banner.textContent).not.toContain('1006');
      await interact(() => must(banner.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry').click());
      expect(retries).toEqual(['x']);
      await interact(() =>
        must(banner.querySelector<HTMLButtonElement>('[data-connection-details]'), 'Details').click(),
      );
      expect(sheetOpen()).toBe(true);
    } finally {
      await shown.unmount();
    }
  });

  it('words every cause in the banner', async () => {
    const headings: Record<Reconnecting['cause'], string> = {
      'device-offline': 'This device is offline',
      'daemon-unreachable': `${MACHINE} is asleep or its daemon is stopped`,
      'relay-unreachable': 'The relay is unreachable',
      unknown: `Can’t reach ${MACHINE}`,
    };
    const shown = await mount(view({ kind: 'unknown' }));
    try {
      for (const [cause, heading] of Object.entries(headings)) {
        await shown.render(view(reconnecting({ stalled: true, cause: cause as Reconnecting['cause'] })));
        const banner = must(shown.container.querySelector('[data-connection-stall]'), `the ${cause} banner`);
        expect(banner.querySelector('p')?.textContent).toBe(heading);
      }
    } finally {
      await shown.unmount();
    }
  });
});

/** A health object a test drives by hand; `state` returns the same object until it is replaced. */
const fakeHealth = (initial: ConnectionHealthState) => {
  let current = initial;
  const listeners = new Set<() => void>();
  const retried: DaemonId[] = [];
  const health: ConnectionHealth = {
    state: () => current,
    subscribe: (_daemon, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retryNow: daemon => void retried.push(daemon),
    onRecovered: () => () => {},
  };
  const publish = (next: ConnectionHealthState): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  return { health, publish, retried };
};

describe('ConnectionHealthNotice', () => {
  it('reads the machine’s health, follows it, and retries that machine', async () => {
    const fake = fakeHealth({ kind: 'connected' });
    const shown = await mount(
      <ConnectionHealthNotice health={fake.health} daemonId={DAEMON} machineName={MACHINE} now={() => NOW} />,
    );
    try {
      expect(pill()).toBeNull();
      await interact(() => fake.publish(reconnecting({ stalled: true })));
      const banner = must(shown.container.querySelector('[data-connection-stall]'), 'the banner');
      await interact(() => must(banner.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry').click());
      expect(fake.retried).toEqual([DAEMON]);
      await interact(() => fake.publish(reconnecting()));
      expect(must(pill(), 'the pill').textContent).toBe('Reconnecting…· retrying in 4s');
      await interact(() => fake.publish({ kind: 'connected' }));
      expect(pill()).toBeNull();
    } finally {
      await shown.unmount();
    }
  });
});
