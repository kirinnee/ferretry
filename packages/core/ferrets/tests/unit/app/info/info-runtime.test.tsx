/** Info › Runtime: what this ferret runs as, and the Settings row when the host reads it. */

import { afterEach, describe, expect, it } from 'bun:test';
import { type InfoRelaunchRead, InfoRelaunchRow } from '../../../../app/features/info/info-relaunch.tsx';
import { InfoRuntime } from '../../../../app/features/info/info-runtime.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { ferretOf } from './fixtures.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const row = (root: HTMLElement, label: string): string =>
  root.querySelector(`[data-info-row="${label}"] dd`)?.textContent ?? '';

describe('InfoRuntime', () => {
  it('names the CLI, runtime, login with its scope, model, mode and runner', async () => {
    mounted = await mount(
      <InfoRuntime
        ferret={ferretOf('f1', {
          harness: 'codex',
          runtime: 'codex-default',
          login: 'codex-a',
          model: 'gpt-6',
          mode: 'auto',
        })}
      />,
    );
    const root = mounted.container;
    expect(row(root, 'CLI')).toBe('Codex');
    expect(row(root, 'Runtime')).toBe('codex-default');
    expect(row(root, 'Login')).toContain('codex-a');
    expect(row(root, 'Login')).toContain('Codex-only');
    expect(row(root, 'Model')).toBe('gpt-6');
    expect(row(root, 'Mode')).toBe('auto');
    expect(row(root, 'Runner')).toBe('tmux');
  });

  it('says what it does not know instead of inventing it', async () => {
    mounted = await mount(<InfoRuntime ferret={ferretOf('f1')} />);
    const root = mounted.container;
    expect(row(root, 'Login')).toContain('The CLI’s own');
    expect(row(root, 'Model')).toContain('default');
    expect(row(root, 'Mode')).toContain('Not recorded');
    expect(root.querySelector('[data-info-row="Runtime"]')).toBeNull();
  });

  it('draws the model and effort pickers only when a host hands them in', async () => {
    mounted = await mount(<InfoRuntime controls={<b data-picker="">pick</b>} ferret={ferretOf('f1')} />);
    expect(mounted.container.querySelector('[data-picker]')).not.toBeNull();
  });

  it('draws the Settings row only when the host reads it', async () => {
    mounted = await mount(<InfoRuntime ferret={ferretOf('f1')} />);
    expect(mounted.container.querySelector('[data-info-row="Settings"]')).toBeNull();
    await mounted.unmount();
    mounted = await mount(
      <InfoRuntime
        ferret={ferretOf('f1')}
        onRestart={async () => true}
        relaunch={{ kind: 'ready', settings: { current: false, reasons: ['settings'] } }}
      />,
    );
    expect(mounted.container.querySelector('[data-info-row="Settings"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-info-restart]')).not.toBeNull();
  });
});

const STALE: InfoRelaunchRead = { kind: 'ready', settings: { current: false, reasons: ['arguments', 'settings'] } };

const showRow = async (read: InfoRelaunchRead, onRestart?: () => Promise<boolean>) => {
  mounted = await mount(
    <dl>
      <InfoRelaunchRow read={read} {...(onRestart === undefined ? {} : { onRestart })} />
    </dl>,
  );
  return mounted.container;
};

describe('InfoRelaunchRow', () => {
  it('says it is checking, then what a failed check said', async () => {
    expect((await showRow({ kind: 'loading' })).textContent).toContain('Checking…');
    await mounted?.unmount();
    mounted = undefined;
    expect((await showRow({ kind: 'failed', reason: 'no ferret' })).textContent).toContain('Couldn’t check: no ferret');
  });

  it('marks a CLI on current settings as current and offers nothing', async () => {
    const root = await showRow({ kind: 'ready', settings: { current: true, reasons: [] } }, async () => true);
    expect(root.querySelector('[data-info-settings="current"]')?.textContent).toBe('Current');
    expect(root.querySelector('[data-info-restart]')).toBeNull();
  });

  it('says a stale CLI runs with older settings, why, and restarts it in one tap', async () => {
    let finish = (): void => {};
    const root = await showRow(
      STALE,
      () =>
        new Promise<boolean>(resolve => {
          finish = () => resolve(true);
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
    expect(root.querySelector('[data-info-settings="restarted"]')?.textContent).toContain('Restarted');
  });

  it('does not claim a restart the daemon paused, and offers the Restart again', async () => {
    const root = await showRow(STALE, async () => false);
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    expect(root.querySelector('[data-info-settings="restarted"]')).toBeNull();
    expect(root.textContent).not.toContain('Restarted');
    expect(must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').disabled).toBe(false);
  });

  it('says why a restart failed and lets it be tried again', async () => {
    const root = await showRow(STALE, async () => {
      throw new Error('owner only');
    });
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    expect(must(root.querySelector('[role="alert"]'), 'alert').textContent).toContain('owner only');
    expect(must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').disabled).toBe(false);
  });

  it('shows the reason but no Restart to a viewer who may not restart it', async () => {
    const root = await showRow(STALE);
    expect(root.textContent).toContain('Running with older settings');
    expect(root.querySelector('[data-info-restart]')).toBeNull();
  });
});
