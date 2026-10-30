import { afterEach, describe, expect, it } from 'bun:test';
import type { RestartResult } from '@ferretry/protocol';
import { OutdatedMark } from '../../../../src/features/restart-outdated/outdated-mark.tsx';
import { RestartOutdatedStrip } from '../../../../src/features/restart-outdated/restart-outdated-strip.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const stale = (id: string) => ({ ...sessionView(id), outdated: { sections: ['pack'] } }) as never;
const SESSIONS = [stale('a'), stale('b'), sessionView('c')];

describe('OutdatedMark', () => {
  it('should draw the word with the sections in its name, only on an outdated ferret', async () => {
    mounted = await mount(<OutdatedMark view={stale('a')} />);
    const mark = must(mounted.container.querySelector('[data-outdated-mark]'), 'mark');
    expect(mark.textContent).toBe('Outdated');
    expect(mark.getAttribute('aria-label')).toContain('(Pack mode)');
    await mounted.unmount();
    mounted = await mount(<OutdatedMark view={sessionView('c')} />);
    expect(mounted.container.querySelector('[data-outdated-mark]')).toBeNull();
  });
});

describe('RestartOutdatedStrip', () => {
  it('should draw nothing without a restart, or with nothing outdated', async () => {
    mounted = await mount(<RestartOutdatedStrip sessions={SESSIONS} />);
    expect(mounted.container.querySelector('[data-restart-outdated]')).toBeNull();
    await mounted.unmount();
    mounted = await mount(<RestartOutdatedStrip onRestart={async () => EMPTY} sessions={[sessionView('c')]} />);
    expect(mounted.container.querySelector('[data-restart-outdated]')).toBeNull();
    await mounted.unmount();
    mounted = await mount(<RestartOutdatedStrip onRestart={async () => EMPTY} sessions={null} />);
    expect(mounted.container.querySelector('[data-restart-outdated]')).toBeNull();
  });

  it('should show the count, restart once on press and say what went now and what waits', async () => {
    const requests: unknown[] = [];
    let finish: (result: RestartResult) => void = () => {};
    mounted = await mount(
      <RestartOutdatedStrip
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
    const button = must(root.querySelector<HTMLButtonElement>('[data-restart-outdated-button]'), 'button');
    expect(button.textContent).toBe('Restart outdated (2)');

    await interact(() => button.click());
    expect(button.textContent).toBe('Restarting…');
    expect(button.disabled).toBe(true);
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
    expect(root.querySelector('[data-restart-outdated]')).not.toBeNull();
  });

  it('should keep the answer on screen after the count falls to zero, until dismissed', async () => {
    mounted = await mount(<RestartOutdatedStrip onRestart={async () => EMPTY} sessions={SESSIONS} />);
    await interact(() => must(mounted?.container.querySelector<HTMLButtonElement>('button'), 'button').click());
    await mounted.render(<RestartOutdatedStrip onRestart={async () => EMPTY} sessions={[sessionView('c')]} />);
    const root = mounted.container;
    expect(root.querySelector('[data-restart-outdated-button]')).toBeNull();
    expect(root.querySelector('[data-restart-outdated-result]')?.textContent).toContain('Nothing needed restarting.');
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'dismiss').click(),
    );
    expect(root.querySelector('[data-restart-outdated]')).toBeNull();
  });

  it('should say why a restart failed and let it be tried again', async () => {
    mounted = await mount(
      <RestartOutdatedStrip
        onRestart={async () => {
          throw new Error('the daemon is restarting');
        }}
        sessions={SESSIONS}
      />,
    );
    const root = mounted.container;
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-restart-outdated-button]'), 'b').click());
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toContain('the daemon is restarting');
    expect(must(root.querySelector<HTMLButtonElement>('[data-restart-outdated-button]'), 'b').disabled).toBe(false);
    await interact(() => must(root.querySelector<HTMLButtonElement>('.fy-restart-outdated__dismiss'), 'd').click());
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('should word a refusal that is not an Error', async () => {
    mounted = await mount(
      <RestartOutdatedStrip
        onRestart={async () => {
          throw 'refused';
        }}
        sessions={SESSIONS}
      />,
    );
    await interact(() => must(mounted?.container.querySelector<HTMLButtonElement>('button'), 'b').click());
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain('the daemon could not be reached');
  });
});

const EMPTY: RestartResult = { restarted: [], queued: [], skipped: [], failed: [] };
