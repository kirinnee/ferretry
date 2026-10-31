import { describe, expect, it } from 'bun:test';
import { WardenCombinedTotals } from '../../../src/features/warden/warden-combined-totals.tsx';
import type { WardenOverviewClient } from '../../../src/features/warden/warden-overview-surface.tsx';
import { combinedTodayTotals } from '../../../src/features/warden/warden-stats-model.ts';
import { WardenTotalsSurface } from '../../../src/features/warden/warden-totals-surface.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';
import { wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const none = { auto: 0, jev: 0, llm: 0 };
const today = (flags: number, moved: number) =>
  wardenStatus({
    history: [
      {
        day: '2026-07-31',
        flags,
        jevDecisions: flags,
        investigations: 0,
        jevUsd: 0,
        investigationUsd: 0,
        moved: { ...none, auto: moved },
        cleared: none,
        stopped: none,
        asked: none,
      },
    ],
  });

describe('WardenCombinedTotals', () => {
  it('should name the five sums and omit a coverage note when every daemon was counted', async () => {
    const view = await mount(<WardenCombinedTotals totals={combinedTodayTotals([today(7, 3), today(2, 1)], NOW)} />);
    const line = view.container.querySelector('[data-warden-combined]');
    expect(line?.textContent?.trim()).toBe('All daemons today Flagged 9 Moved 4 Cleared 0 Stopped 0 Asked you 0');
    await view.unmount();
  });

  it('should say how many daemons it covers when one could not be read', async () => {
    const view = await mount(<WardenCombinedTotals totals={combinedTodayTotals([today(7, 3), undefined], NOW)} />);
    expect(view.container.textContent).toContain('from 1 of 2 daemons');
    await view.unmount();
  });

  it('should draw nothing when no daemon could say', async () => {
    const view = await mount(<WardenCombinedTotals totals={combinedTodayTotals([undefined], NOW)} />);
    expect(view.container.querySelector('[data-warden-combined]')).toBeNull();
    await view.unmount();
  });
});

describe('WardenTotalsSurface', () => {
  it('should read each daemon through its own connection and add the answers', async () => {
    const ec2 = daemonConnection({ daemonId: 'daemon-ec2', baseUrl: 'https://ec2.example.test', deviceId: 'a' });
    const mbp = daemonConnection({ daemonId: 'daemon-mbp', baseUrl: 'https://mbp.example.test', deviceId: 'b' });
    const answers = new Map([
      ['daemon-ec2', today(7, 3)],
      ['daemon-mbp', today(2, 1)],
    ]);
    const asked: string[] = [];
    const machines = [
      { connection: ec2, name: 'Liftoff EC2' },
      { connection: mbp, name: 'Liftoff MBP' },
    ];
    const view = await mount(
      <WardenTotalsSurface
        machines={machines}
        now={() => NOW}
        pollOptions={{ isHidden: () => false, pollMs: 3_600_000 }}
        createClient={async connection =>
          ({
            wardenStatus: async () => {
              asked.push(connection.daemonId);
              return answers.get(connection.daemonId) as ReturnType<typeof today>;
            },
          }) as unknown as WardenOverviewClient
        }
      />,
    );
    for (let index = 0; index < 3; index += 1)
      await interact(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    expect(asked.sort()).toEqual(['daemon-ec2', 'daemon-mbp']);
    expect(view.container.textContent).toContain('Flagged 9');
    expect(view.container.textContent).toContain('Moved 4');
    await view.unmount();
  });
});
