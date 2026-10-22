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
const OTHER = 'studio';
const OTHER_DAEMON = daemonId('studio-daemon');

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

const view = (
  state: ConnectionHealthState,
  onRetryNow: (daemon: DaemonId) => void = () => {},
  other: ConnectionHealthState | null = null,
) => (
  <ConnectionHealthNoticeView
    machines={[
      { daemonId: DAEMON, name: MACHINE, state },
      ...(other === null ? [] : [{ daemonId: OTHER_DAEMON, name: OTHER, state: other }]),
    ]}
    now={NOW}
    onRetryNow={onRetryNow}
  />
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

  it('names a stalled machine in the pill whatever the outage age says, and never draws a banner', async () => {
    const shown = await mount(view(reconnecting({ since: NOW, stalled: true })));
    try {
      expect(must(pill(), 'the pill').textContent).toBe(`${MACHINE} offline`);
      expect(pill()?.getAttribute('data-connection-pill')).toBe('offline');
      expect(shown.container.querySelector('[data-connection-stall]')).toBeNull();
    } finally {
      await shown.unmount();
    }
  });

  it('counts every machine that is down, and says nothing about the one that is fine', async () => {
    const shown = await mount(
      view(reconnecting({ stalled: true }), () => {}, reconnecting({ stalled: true, cause: 'daemon-unreachable' })),
    );
    try {
      expect(must(pill(), 'the pill').textContent).toBe('2 machines offline');
      await shown.render(view({ kind: 'connected' }, () => {}, reconnecting({ stalled: true })));
      expect(must(pill(), 'the pill').textContent).toBe(`${OTHER} offline`);
      expect(shown.container.textContent).not.toContain(MACHINE);
    } finally {
      await shown.unmount();
    }
  });

  it('hides on ×, stays hidden while the same machines are down, and returns when another goes down', async () => {
    const shown = await mount(view(reconnecting({ stalled: true }), () => {}, { kind: 'connected' }));
    try {
      await interact(() =>
        must(document.querySelector<HTMLButtonElement>('[data-connection-dismiss]'), 'dismiss').click(),
      );
      expect(pill()).toBeNull();
      await shown.render(view(reconnecting({ stalled: true, attempt: 5 }), () => {}, { kind: 'connected' }));
      expect(pill()).toBeNull();
      await shown.render(view(reconnecting({ stalled: true }), () => {}, reconnecting({ stalled: true })));
      expect(must(pill(), 'the pill').textContent).toBe('2 machines offline');
      // Recovery forgets the dismissal, so the same machine's next outage is said again.
      await shown.render(view({ kind: 'connected' }, () => {}, { kind: 'connected' }));
      await shown.render(view(reconnecting({ stalled: true }), () => {}, { kind: 'connected' }));
      expect(must(pill(), 'the pill').textContent).toBe(`${MACHINE} offline`);
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
      expect(button.getAttribute('data-connection-pill')).toBe('reconnecting');
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
    const shown = await mount(view(state, daemon => retries.push(String(daemon))));
    try {
      const button = must(pill(), 'the pill');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(sheetOpen()).toBe(false);
      await interact(() => button.click());
      expect(sheetOpen()).toBe(true);
      expect(must(pill(), 'the pill').getAttribute('aria-expanded')).toBe('true');
      const body = must(sheet(), 'the sheet');
      expect(body.textContent).toContain(`Trying to reach ${MACHINE} again.`);
      expect(body.textContent).toContain('The relay is unreachable.');
      expect(must(body.querySelector('[data-connection-meta]'), 'the meta line').textContent).toBe(
        'Lost 12 seconds ago · 2 automatic attempts',
      );
      const carriers = [...body.querySelectorAll('[data-connection-carrier]')].map(row =>
        row.getAttribute('data-connection-carrier'),
      );
      expect(carriers).toEqual(['Direct', 'Hosted relay']);
      await interact(() => must(body.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry now').click());
      expect(retries).toEqual([String(DAEMON)]);
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

  it('gives each machine that is down its own section in the sheet, with its own cause and Retry now', async () => {
    const retries: string[] = [];
    const shown = await mount(
      view(
        reconnecting({ stalled: true, cause: 'daemon-unreachable' }),
        daemon => retries.push(String(daemon)),
        reconnecting({ stalled: true, cause: 'device-offline', failures: [] }),
      ),
    );
    try {
      await interact(() => must(pill(), 'the pill').click());
      const sections = [...must(sheet(), 'the sheet').querySelectorAll('[data-connection-machine]')];
      expect(sections.map(section => section.getAttribute('data-connection-machine'))).toEqual([
        String(DAEMON),
        String(OTHER_DAEMON),
      ]);
      expect(sections[0]?.textContent).toContain(`${MACHINE} is asleep or its daemon is stopped.`);
      expect(sections[0]?.textContent).toContain('Wake the machine, or start its daemon by running fyd on it.');
      expect(sections[1]?.textContent).toContain('This device is offline.');
      await interact(() =>
        must(sections[1]?.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry').click(),
      );
      expect(retries).toEqual([String(OTHER_DAEMON)]);
      await shown.render(view({ kind: 'connected' }, () => {}, { kind: 'connected' }));
      expect(must(sheet(), 'the sheet').textContent).toContain('Every machine is connected.');
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
      <ConnectionHealthNotice health={fake.health} machines={[{ daemonId: DAEMON, name: MACHINE }]} now={() => NOW} />,
    );
    try {
      expect(pill()).toBeNull();
      await interact(() => fake.publish(reconnecting({ stalled: true })));
      expect(must(pill(), 'the pill').textContent).toBe(`${MACHINE} offline`);
      await interact(() => must(pill(), 'the pill').click());
      await interact(() => must(document.querySelector<HTMLButtonElement>('[data-connection-retry]'), 'Retry').click());
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
