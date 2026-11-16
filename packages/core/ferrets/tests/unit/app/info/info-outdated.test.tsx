/**
 * S-0320 the outdated/queued mark beside Restart in Info › Overview (v4's `info-about.tsx` RestartRow): the same mark the
 * list's rows draw, from the same answer, visible even to a reader who may not restart the ferret.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InfoOverview, type InfoOverviewProps } from '../../../../app/features/info/info-overview.tsx';
import { useRestartOverlay } from '../../../../app/features/restart-outdated/restart-overlay.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { ferretOf, NOW } from './fixtures.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const OUTDATED = { sections: ['pack', 'agenda'] };

const show = async (overrides: Partial<InfoOverviewProps> = {}): Promise<HTMLElement> => {
  mounted = await mount(
    <InfoOverview
      ferret={ferretOf('f1', { outdated: OUTDATED })}
      name="Hadi"
      now={NOW}
      worktrees={null}
      write={async () => {}}
      {...overrides}
    />,
  );
  return mounted.container;
};

const about = (root: HTMLElement): HTMLElement => must(root.querySelector<HTMLElement>('[data-info-about]'), 'about');
const mark = (root: HTMLElement): HTMLElement | null => about(root).querySelector<HTMLElement>('.fy-outdated-mark');
const restartRow = (root: HTMLElement): HTMLElement | null =>
  about(root).querySelector<HTMLElement>('[data-info-row="Restart"]');

describe('S-0320 Info › Overview marks an outdated ferret beside Restart', () => {
  it('S-0320 an outdated ferret shows the mark, with its sections in the label, next to the Restart button', async () => {
    const root = await show({ about: { onRestart: async () => true } });
    expect(mark(root)?.getAttribute('aria-label')).toBe(
      'Outdated — restart to load new instructions (Pack mode and agenda)',
    );
    const row = must(restartRow(root), 'the Restart row');
    expect(row.querySelector('[data-info-restart]')).not.toBeNull();
    expect(row.contains(mark(root))).toBe(true);
  });

  it('S-0320 an up-to-date ferret shows no mark, and no Restart row at all without a restart', async () => {
    const withRestart = await show({ ferret: ferretOf('f1'), about: { onRestart: async () => true } });
    expect(mark(withRestart)).toBeNull();
    expect(withRestart.querySelector('[data-info-restart]')).not.toBeNull();
    await mounted?.unmount();
    const bare = await show({ ferret: ferretOf('f1') });
    expect(restartRow(bare)).toBeNull();
  });

  it('S-0320 a stopped ferret has nothing a restart can fix: no mark', async () => {
    const root = await show({
      ferret: ferretOf('f1', { state: 'stopped', outdated: OUTDATED }),
      about: { onRestart: async () => true },
    });
    expect(mark(root)).toBeNull();
  });

  it('S-0320 a read-only reader (no restart permission) still sees that the ferret is outdated, with no button', async () => {
    const root = await show();
    expect(mark(root)?.getAttribute('data-outdated-mark')).toBe('');
    expect(root.querySelector('[data-info-restart]')).toBeNull();
    expect(restartRow(root)).not.toBeNull();
  });

  it('S-0320 follows what "Restart outdated" last answered for this daemon: Queued, then gone once restarted', async () => {
    const key = {};
    let control: ReturnType<typeof useRestartOverlay> | undefined;
    const Spy = () => {
      control = useRestartOverlay(key);
      return null;
    };
    mounted = await mount(
      <>
        <Spy />
        <InfoOverview
          about={{ overlayKey: key }}
          ferret={ferretOf('f1', { outdated: OUTDATED })}
          name="Hadi"
          now={NOW}
          worktrees={null}
          write={async () => {}}
        />
      </>,
    );
    const root = mounted.container;
    expect(mark(root)?.getAttribute('data-outdated-mark')).toBe('');
    await interact(() =>
      control?.record({ restarted: [], queued: [{ id: 'f1', reason: 'mid-turn' }], skipped: [], failed: [] }),
    );
    expect(mark(root)?.getAttribute('data-outdated-mark')).toBe('queued');
    await interact(() => control?.record({ restarted: [{ id: 'f1' }], queued: [], skipped: [], failed: [] }));
    expect(mark(root)).toBeNull();
    // Another daemon's key is another answer.
    await interact(() => control?.clear());
    expect(mark(root)?.getAttribute('data-outdated-mark')).toBe('');
  });
});
