import { afterEach, describe, expect, it } from 'bun:test';
import type { RestartResult, SessionView } from '@ferretry/protocol';
import { OutdatedMark } from '../../../../src/features/restart-outdated/outdated-mark.tsx';
import {
  RestartOutdatedResult,
  useRestartOutdated,
} from '../../../../src/features/restart-outdated/restart-outdated-strip.tsx';
import { RestartOverlayProvider } from '../../../../src/features/restart-outdated/restart-overlay.tsx';
import { SessionsBarOptions } from '../../../../src/shell/sessions-bar-options.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const stale = (id: string) => ({ ...sessionView(id), outdated: { sections: ['pack'] } }) as never;
const SESSIONS: readonly SessionView[] = [stale('a'), stale('b'), sessionView('c')];

describe('OutdatedMark', () => {
  it('should draw a compact icon, not a word, with the sections in its name, only on an outdated ferret', async () => {
    mounted = await mount(<OutdatedMark view={stale('a')} />);
    const mark = must(mounted.container.querySelector('[data-outdated-mark]'), 'mark');
    expect(mark.textContent).toBe('');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark.getAttribute('aria-label')).toBe('Outdated — restart to load new instructions (Pack mode)');
    expect(mark.getAttribute('title')).toBe(mark.getAttribute('aria-label'));
    await mounted.unmount();
    mounted = await mount(<OutdatedMark view={sessionView('c')} />);
    expect(mounted.container.querySelector('[data-outdated-mark]')).toBeNull();
  });
});

type Restart = (request: unknown) => Promise<RestartResult>;

function Harness({
  sessions,
  onRestart,
}: {
  readonly sessions: readonly SessionView[] | null;
  readonly onRestart?: Restart;
}) {
  const restart = useRestartOutdated(sessions, onRestart);
  return (
    <>
      <SessionsBarOptions hiddenStopped={0} onShowStoppedChange={() => {}} restart={restart} showStopped={false} />
      <RestartOutdatedResult restart={restart} />
    </>
  );
}

const openMenu = async (root: Element): Promise<void> => {
  await interact(() => must(root.querySelector<HTMLButtonElement>('[data-sbar-options]'), 'the ⋯').click());
};
const item = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('[data-menu-key="restart-outdated"]');

describe('Restart outdated in the ⋯ menu', () => {
  it('should offer nothing without a restart, or with nothing outdated', async () => {
    mounted = await mount(<Harness sessions={SESSIONS} />);
    expect(mounted.container.querySelector('[data-sbar-options-badge]')).toBeNull();
    await openMenu(mounted.container);
    expect(item()).toBeNull();
    await mounted.unmount();
    mounted = await mount(<Harness onRestart={async () => EMPTY} sessions={[sessionView('c')]} />);
    expect(mounted.container.querySelector('[data-sbar-options-badge]')).toBeNull();
    await openMenu(mounted.container);
    expect(item()).toBeNull();
    await mounted.unmount();
    mounted = await mount(<Harness onRestart={async () => EMPTY} sessions={null} />);
    expect(mounted.container.querySelector('[data-sbar-options-badge]')).toBeNull();
  });

  it('should badge the ⋯ with the count while something is outdated, and say so in its name', async () => {
    mounted = await mount(<Harness onRestart={async () => EMPTY} sessions={SESSIONS} />);
    const button = must(mounted.container.querySelector('[data-sbar-options]'), 'the ⋯');
    expect(button.querySelector('[data-sbar-options-badge]')?.textContent).toBe('2');
    expect(button.getAttribute('aria-label')).toBe('Sessions bar options. 2 outdated');
  });

  it('should show the count, restart once on press and say what went now and what waits', async () => {
    const requests: unknown[] = [];
    let finish: (result: RestartResult) => void = () => {};
    mounted = await mount(
      <Harness
        onRestart={request =>
          new Promise<RestartResult>(resolve => {
            requests.push(request);
            finish = resolve;
          })
        }
        sessions={SESSIONS}
      />,
    );
    const root = mounted.container;
    await openMenu(root);
    expect(item()?.textContent).toContain('Restart outdated (2)');

    await interact(() => must(item(), 'the row').click());
    await openMenu(root);
    expect(item()?.textContent).toContain('Restarting…');
    expect(item()?.disabled).toBe(true);
    await interact(() =>
      finish({
        restarted: [{ id: 'a' }],
        queued: [{ id: 'b', reason: 'mid-turn' }],
        skipped: [],
        failed: [],
      }),
    );

    expect(requests).toEqual([{ scope: 'outdated' }]);
    expect(must(root.querySelector('[data-restart-outdated-result]'), 'result').textContent).toContain(
      '1 ferret restarted now, 1 ferret queued for their next idle moment.',
    );
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'dismiss').click(),
    );
    expect(root.querySelector('[data-restart-outdated]')).toBeNull();
  });

  it('should keep the answer on screen after the count falls to zero, until dismissed', async () => {
    mounted = await mount(<Harness onRestart={async () => EMPTY} sessions={SESSIONS} />);
    await openMenu(mounted.container);
    await interact(() => must(item(), 'the row').click());
    await mounted.render(<Harness onRestart={async () => EMPTY} sessions={[sessionView('c')]} />);
    const root = mounted.container;
    expect(root.querySelector('[data-sbar-options-badge]')).toBeNull();
    expect(root.querySelector('[data-restart-outdated-result]')?.textContent).toContain('Nothing needed restarting.');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'dismiss').click(),
    );
    expect(root.querySelector('[data-restart-outdated]')).toBeNull();
  });

  it('should say why a restart failed and let it be tried again', async () => {
    mounted = await mount(
      <Harness
        onRestart={async () => {
          throw new Error('the daemon is restarting');
        }}
        sessions={SESSIONS}
      />,
    );
    const root = mounted.container;
    await openMenu(root);
    await interact(() => must(item(), 'the row').click());
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toContain('the daemon is restarting');
    await openMenu(root);
    expect(item()?.disabled).toBe(false);
    await interact(() => must(item(), 'the row').click());
    await interact(() => must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'd').click());
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('should word a refusal that is not an Error', async () => {
    mounted = await mount(
      <Harness
        onRestart={async () => {
          throw 'refused';
        }}
        sessions={SESSIONS}
      />,
    );
    await openMenu(mounted.container);
    await interact(() => must(item(), 'the row').click());
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain('the daemon could not be reached');
  });
});

describe('after a press', () => {
  it('should drop the mark on a restarted ferret, call a waiting one Queued and lower the count', async () => {
    const result: RestartResult = {
      restarted: [{ id: 'a' }],
      queued: [{ id: 'b', reason: 'mid-turn' }],
      skipped: [],
      failed: [],
    };
    const marks = (): string[] =>
      [...(mounted?.container.querySelectorAll('[data-row]') ?? [])].map(row => {
        const mark = row.querySelector('[data-outdated-mark]');
        return mark === null ? '' : mark.getAttribute('data-outdated-mark') || 'outdated';
      });
    const tree = (
      <RestartOverlayProvider>
        <Harness onRestart={async () => result} sessions={SESSIONS} />
        {SESSIONS.map(view => (
          <div data-row="" key={view.config.id}>
            <OutdatedMark view={view} />
          </div>
        ))}
      </RestartOverlayProvider>
    );
    mounted = await mount(tree);
    const root = mounted.container;
    expect(marks()).toEqual(['outdated', 'outdated', '']);
    await openMenu(root);
    await interact(() => must(item(), 'the row').click());

    expect(marks()).toEqual(['', 'queued', '']);
    expect(root.querySelector('[data-outdated-mark="queued"]')?.getAttribute('aria-label')).toContain(
      'next idle moment',
    );
    expect(root.querySelector('[data-sbar-options-badge]')).toBeNull();
    expect(root.querySelector('[data-restart-outdated-result]')).not.toBeNull();

    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'dismiss').click(),
    );
    expect(marks()).toEqual(['outdated', 'outdated', '']);
    expect(root.querySelector('[data-sbar-options-badge]')?.textContent).toBe('2');
  });
});

const EMPTY: RestartResult = { restarted: [], queued: [], skipped: [], failed: [] };
