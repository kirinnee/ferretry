/** Info › Runtime › Settings: whether the CLI runs on the settings a Restart would give it. */

import { afterEach, describe, expect, it } from 'bun:test';
import { type InfoRelaunchRead, InfoRelaunchRow } from '../../../../src/features/session-info/info-relaunch.tsx';
import { InfoRuntime } from '../../../../src/features/session-info/info-runtime.tsx';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const STALE: InfoRelaunchRead = { kind: 'ready', settings: { current: false, reasons: ['arguments', 'settings'] } };

const show = async (read: InfoRelaunchRead, onRestart?: () => Promise<void>) => {
  mounted = await mount(
    <dl>
      <InfoRelaunchRow read={read} {...(onRestart === undefined ? {} : { onRestart })} />
    </dl>,
  );
  return mounted.container;
};

describe('InfoRelaunchRow', () => {
  it('says it is checking, then what a failed check said', async () => {
    expect((await show({ kind: 'loading' })).textContent).toContain('Checking…');
    await mounted?.unmount();
    mounted = undefined;
    expect((await show({ kind: 'failed', reason: 'no session' })).textContent).toContain('Couldn’t check: no session');
  });

  it('marks a CLI on current settings as current and offers nothing', async () => {
    const root = await show({ kind: 'ready', settings: { current: true, reasons: [] } }, async () => {});
    expect(root.querySelector('[data-info-settings="current"]')?.textContent).toBe('Current');
    expect(root.querySelector('[data-info-restart]')).toBeNull();
  });

  it('says a stale CLI is running with older settings, why, and restarts it in one tap', async () => {
    const restarts: string[] = [];
    let finish = (): void => {};
    const root = await show(
      STALE,
      () =>
        new Promise<void>(resolve => {
          restarts.push('restart');
          finish = resolve;
        }),
    );
    expect(root.textContent).toContain('Running with older settings — Restart to apply');
    expect(root.textContent).toContain('arguments it is missing');
    expect(root.textContent).toContain('settings changed after it started');

    const button = must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart');
    await interact(() => button.click());
    expect(button.textContent).toBe('Restarting…');
    expect(button.disabled).toBe(true);
    await interact(() => finish());

    expect(restarts).toEqual(['restart']);
    expect(root.querySelector('[data-info-settings="restarted"]')?.textContent).toContain('Restarted');
  });

  it('says why a restart failed and lets it be tried again', async () => {
    const root = await show(STALE, async () => {
      throw new Error('the session is mid-turn');
    });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toContain('the session is mid-turn');
    expect(must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').disabled).toBe(false);

    await mounted?.unmount();
    mounted = undefined;
    const plain = await show(STALE, async () => {
      throw 'refused';
    });
    await interact(() => must(plain.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    expect(must(plain.querySelector('[role="alert"]'), 'alert').textContent).toContain('refused');
  });

  it('shows the reason but no Restart to a viewer who may not restart it', async () => {
    const root = await show(STALE);
    expect(root.textContent).toContain('Running with older settings');
    expect(root.querySelector('[data-info-restart]')).toBeNull();
  });
});

describe('InfoRuntime — Settings row', () => {
  it('draws the row only when the host reads it', async () => {
    const base = { instructions: { kind: 'loading' }, mcp: { kind: 'loading' }, skills: null } as const;
    mounted = await mount(<InfoRuntime {...base} view={sessionView('session-a')} />);
    expect(mounted.container.querySelector('[data-info-row="Settings"]')).toBeNull();
    await mounted.unmount();

    mounted = await mount(
      <InfoRuntime {...base} onRestart={async () => {}} relaunch={STALE} view={sessionView('session-a')} />,
    );
    expect(mounted.container.querySelector('[data-info-row="Settings"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-info-restart]')).not.toBeNull();
  });
});
