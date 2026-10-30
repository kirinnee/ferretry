import { describe, expect, it } from 'bun:test';
import {
  DAEMON_FEATURES,
  type WardenLeaveRequest,
  type WardenStatusView,
  WARDEN_AGENDA_PATH,
} from '@ferretry/protocol';

import {
  type WardenOverviewClient,
  WardenOverviewSurface,
  wardenSettingsHref,
} from '../../../src/features/warden/warden-overview-surface.tsx';
import { AgendaWireDirectory } from '../../../src/lib/agenda-wire.ts';
import { daemonConnection, daemonId } from '../../../src/lib/daemon-connection.ts';
import type { DaemonHealthRead } from '../../../src/lib/daemon-health.ts';
import { type AppStore, StoreProvider } from '../../../src/lib/store.tsx';
import { interact, mount, must } from '../../support/dom.ts';
import { healthOf } from '../../support/health.ts';
import { agendaItem, wardenAnomaly, wardenAgenda, wardenInvestigation, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });
const POLL = { isHidden: () => false, pollMs: 3_600_000 } as const;

const settle = async (): Promise<void> => {
  for (let index = 0; index < 3; index += 1)
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
};

interface FakeOptions {
  readonly status?: WardenStatusView;
  readonly run?: WardenOverviewClient['wardenRun'];
  readonly leave?: WardenOverviewClient['wardenLeave'];
}

const fake = (options: FakeOptions = {}) => {
  const calls = {
    status: 0,
    runs: [] as (boolean | undefined)[],
    leaves: [] as WardenLeaveRequest[],
    requests: [] as string[],
  };
  const client: WardenOverviewClient = {
    wardenStatus: async () => {
      calls.status += 1;
      return (
        options.status ??
        wardenStatus({
          lastSweepAt: '2026-07-31T11:59:00.000Z',
          anomalies: [wardenAnomaly({ sessionId: 'sess-flag' })],
          investigations: [
            wardenInvestigation({
              id: 'done-1',
              state: 'done',
              targetSession: 'sess-done',
              verdict: 'killed',
              reportPath: 'reports/done.md',
            }),
          ],
        })
      );
    },
    request: (async (path: string, schema: { parse: (value: unknown) => unknown }) => {
      calls.requests.push(path);
      return schema.parse(
        wardenAgenda({
          outcome: 'items',
          items: [agendaItem({ sessionId: 'sess-new', source: 'warden-anomaly', anomalyKind: 'dead_monitor' })],
        }),
      );
    }) as WardenOverviewClient['request'],
    wardenAgenda: async () =>
      wardenAgenda({
        outcome: 'items',
        items: [agendaItem({ sessionId: 'sess-flag', source: 'warden-anomaly', anomalyKind: 'dead_monitor' })],
      }),
    wardenRun: async spawn => {
      calls.runs.push(spawn);
      return await (options.run ?? (async () => ({ sweptAt: '2026-07-31T12:00:00.000Z', anomalies: [] })))(spawn);
    },
    wardenLeave: async request => {
      calls.leaves.push(request);
      if (options.leave !== undefined) return await options.leave(request);
      return {
        blessing: {
          sessionId: request.sessionId,
          kinds: ['dead_monitor'],
          expiresAt: '2026-07-31T13:00:00.000Z',
          by: 'owner',
        },
        message: 'Left alone for 1 h.',
      };
    },
    wardenReport: async path => `# Evidence from ${path}`,
  };
  return { client, calls };
};

const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text)),
    `the ${text} button`,
  );

describe('WardenOverviewSurface', () => {
  it('should point Settings at the daemon’s Warden panel', () => {
    // Arrange
    const daemon = connection('a');

    // Act
    const href = wardenSettingsHref(daemon);

    // Assert
    expect(href).toBe('/d/a/settings#warden');
  });

  it('should read through the paired client, sweep without spawning and say nothing was flagged', async () => {
    // Arrange
    const { client, calls } = fake();
    const view = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        createClient={async () => client}
        now={() => NOW}
        pollOptions={POLL}
      />,
    );
    try {
      await settle();
      const before = calls.status;

      // Act
      await interact(() => button(view.container, 'Sweep now').click());
      await settle();

      // Assert
      expect(view.container.textContent).toContain('Swept: nothing flagged.');
      expect(calls.runs).toEqual([false]);
      expect(calls.status).toBeGreaterThan(before);
    } finally {
      await view.unmount();
    }
  });

  it('should count what a sweep flagged, prefer the daemon’s own words, and report a failed sweep', async () => {
    // Arrange
    const counted = fake({
      run: async () => ({ sweptAt: '2026-07-31T12:00:00.000Z', anomalies: [wardenAnomaly(), wardenAnomaly()] }),
    });
    const worded = fake({
      run: async () => ({ sweptAt: '2026-07-31T12:00:00.000Z', anomalies: [], message: 'Swept by the daemon.' }),
    });
    const failed = fake({
      run: async () => {
        throw 'refused';
      },
    });
    const views = [];
    for (const { client } of [counted, worded, failed])
      views.push(
        await mount(
          <WardenOverviewSurface
            connection={connection('a')}
            createClient={async () => client}
            now={() => NOW}
            pollOptions={POLL}
          />,
        ),
      );
    try {
      await settle();

      // Act
      for (const view of views)
        await interact(() =>
          must(
            [...view.container.querySelectorAll('button')].find(node => node.textContent?.includes('Sweep now')),
            'sweep',
          ).click(),
        );
      await settle();

      // Assert
      expect(views[0]?.container.textContent).toContain('Swept: 2 flagged.');
      expect(views[1]?.container.textContent).toContain('Swept by the daemon.');
      expect(views[2]?.container.textContent).toContain('The sweep did not run: refused');
    } finally {
      for (const view of views) await view.unmount();
    }
  });

  it('should leave a flagged ferret alone longer and show the daemon’s answer or its refusal', async () => {
    // Arrange
    const accepted = fake();
    const refused = fake({
      leave: async () => {
        throw new Error('409: nothing is flagged');
      },
    });
    const ok = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        createClient={async () => accepted.client}
        now={() => NOW}
        pollOptions={POLL}
      />,
    );
    const no = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        createClient={async () => refused.client}
        now={() => NOW}
        pollOptions={POLL}
      />,
    );
    try {
      await settle();
      const press = (container: HTMLElement, label: string) =>
        must(
          [...container.querySelectorAll('button')].find(item => item.textContent === label),
          label,
        ).click();

      // Act
      await interact(() => press(ok.container, 'Leave it longer…'));
      await interact(() => press(ok.container, 'Until it changes'));
      await interact(() => press(no.container, 'Leave it longer…'));
      await interact(() => press(no.container, 'For 1 hour'));
      await settle();

      // Assert
      expect(accepted.calls.leaves).toEqual([{ sessionId: 'sess-flag', duration: 'until_change' }]);
      expect(ok.container.textContent).toContain('Left alone for 1 h.');
      expect(no.container.textContent).toContain('Not left alone: 409: nothing is flagged');
    } finally {
      await ok.unmount();
      await no.unmount();
    }
  });

  it('should open a finished investigation’s report and close it again', async () => {
    // Arrange
    const { client } = fake();
    const view = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        createClient={async () => client}
        now={() => NOW}
        pollOptions={POLL}
      />,
    );
    try {
      await settle();

      // Act
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('button[aria-label="Open report"]'), 'report').click(),
      );
      await settle();
      const opened = view.container.textContent ?? '';
      await interact(() =>
        must(
          view.container.querySelector<HTMLButtonElement>('button[aria-label="Close Warden report"]'),
          'close',
        ).click(),
      );

      // Assert
      expect(opened).toContain('Evidence from reports/done.md');
      expect(view.container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should open a fleet triage’s report, which is about no one ferret', async () => {
    // Arrange
    const { targetSession: _none, ...fleetWide } = wardenInvestigation({
      id: 'fleet-1',
      state: 'done',
      scope: 'fleet',
      verdict: 'needs_human',
      reportPath: 'reports/fleet.md',
      wardenName: 'warden-000023',
    });
    const { client } = fake({
      status: wardenStatus({ lastSweepAt: '2026-07-31T11:59:00.000Z', investigations: [fleetWide] }),
    });
    const view = await mount(
      <WardenOverviewSurface
        connection={connection('a')}
        createClient={async () => client}
        now={() => NOW}
        pollOptions={POLL}
      />,
    );
    try {
      await settle();

      // Act
      await interact(() =>
        must(view.container.querySelector<HTMLButtonElement>('button[aria-label="Open report"]'), 'report').click(),
      );
      await settle();

      // Assert
      expect(view.container.textContent).toContain('warden-000023 · Fleet triage');
      expect(view.container.textContent).toContain('Evidence from reports/fleet.md');
    } finally {
      await view.unmount();
    }
  });

  it('should remount for another daemon and refuse outside the app store without a client', async () => {
    // Arrange
    const { client } = fake({ status: wardenStatus({ anomalies: [wardenAnomaly({ sessionId: 'only-a' })] }) });
    const view = await mount(
      <WardenOverviewSurface connection={connection('a')} createClient={async () => client} pollOptions={POLL} />,
    );
    try {
      await settle();
      const onA = view.container.textContent ?? '';

      // Act
      await view.render(<WardenOverviewSurface connection={connection('b')} pollOptions={POLL} />);
      await settle();

      // Assert
      expect(onA).toContain('only-a');
      expect(view.container.textContent).not.toContain('only-a');
      expect(view.container.textContent).toContain('no daemon client exists outside the app store');
    } finally {
      await view.unmount();
    }
  });
});

describe('WardenOverviewSurface agenda wire', () => {
  const wires = (read: DaemonHealthRead) => {
    const agendaWire = new AgendaWireDirectory();
    agendaWire.note(daemonId('a'), read);
    return { agendaWire } as unknown as AppStore;
  };
  const NEW: DaemonHealthRead = { kind: 'read', health: healthOf('4.108.0', [DAEMON_FEATURES.agendaWire]) };
  const OLD: DaemonHealthRead = { kind: 'read', health: healthOf('4.84.0') };

  it('should ask a daemon that speaks the agenda wire for the agenda route', async () => {
    // Arrange
    const { client, calls } = fake();
    const view = await mount(
      <StoreProvider store={wires(NEW)}>
        <WardenOverviewSurface
          connection={connection('a')}
          createClient={async () => client}
          now={() => NOW}
          pollOptions={POLL}
        />
      </StoreProvider>,
    );
    try {
      // Act
      await settle();

      // Assert
      expect(calls.requests).toEqual([WARDEN_AGENDA_PATH]);
    } finally {
      await view.unmount();
    }
  });

  it('should keep asking an older daemon, and a machine nobody read, the attention route', async () => {
    // Arrange
    const { client, calls } = fake();
    const view = await mount(
      <StoreProvider store={wires(OLD)}>
        <WardenOverviewSurface
          connection={connection('a')}
          createClient={async () => client}
          now={() => NOW}
          pollOptions={POLL}
        />
      </StoreProvider>,
    );
    try {
      // Act
      await settle();

      // Assert
      expect(calls.requests).toEqual([]);
    } finally {
      await view.unmount();
    }
  });
});
