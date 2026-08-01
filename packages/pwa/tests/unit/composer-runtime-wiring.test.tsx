/**
 * THE HAND-OFF PR #129 LEFT OPEN, CLOSED AND ASSERTED.
 *
 * `composer-runtime.tsx` owns the bar, its two chips and its two sheets, and
 * takes each sheet's BODY as a render prop so there would be exactly one
 * implementation of the harness rules rather than a second copy inside the bar.
 * These tests render the real bar with the real controls to prove that the
 * lifecycle it hands down is the one the controls accept — a spread, nothing
 * adapted, nothing reimplemented.
 */

import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { ComposerRuntime } from '../../src/components/composer-runtime.tsx';
import {
  type RuntimeControlCommand,
  RuntimeEffortControls,
  type RuntimeModelCatalogSource,
  RuntimeModelControls,
} from '../../src/components/runtime-controls.tsx';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceToken: 'token-a' });

const view: SessionView = sessionView('s-1', {
  config: { harness: 'claude', model: 'claude-opus-5' },
  state: { status: 'running', promptReady: true, observedModel: 'claude-opus-5' },
});

const catalogs: RuntimeModelCatalogSource = {
  load: async () => ({
    harness: 'claude',
    source: 'wrapper-inventory',
    choices: [
      { value: 'claude-opus-5', label: 'Opus 5', reasoningEfforts: [] },
      { value: 'claude-sonnet-5', label: 'Sonnet 5', reasoningEfforts: [] },
    ],
  }),
};

const recorder = () => {
  const sent: RuntimeControlCommand[] = [];
  return {
    sent,
    api: {
      runtime: async (_daemon: DaemonConnection, _sessionId: string, command: RuntimeControlCommand) => {
        sent.push(command);
      },
    },
  };
};

const bar = (api: { runtime: (...args: never[]) => Promise<void> }) => {
  const shared = { api, canControl: true, catalogs, daemon: alpha, newRequestId: () => 'req-1', view } as const;
  return (
    <ComposerRuntime
      busy={false}
      canControl
      renderEffortControls={lifecycle => <RuntimeEffortControls {...shared} {...lifecycle} />}
      renderModelControls={lifecycle => <RuntimeModelControls {...shared} {...lifecycle} open />}
      view={view}
    />
  );
};

const byLabelPrefix = (container: HTMLElement, prefix: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(button =>
      (button.getAttribute('aria-label') ?? '').startsWith(prefix),
    ),
    `a button labelled ${prefix}…`,
  );

const click = (button: HTMLButtonElement) =>
  interact(() => button.dispatchEvent(new Event('click', { bubbles: true })));

describe('ComposerRuntime with the ported runtime controls', () => {
  test('opens the model sheet on the bar and fills it with the real control', async () => {
    const { api, sent } = recorder();
    const screen = await mount(bar(api));

    await click(byLabelPrefix(screen.container, 'Switch model'));
    expect(screen.container.textContent).toContain('Switch model in place');
    expect(screen.container.textContent).toContain('Only this account’s advertised Claude choices are shown');

    await click(byLabelPrefix(screen.container, 'Switch model in place to Sonnet 5'));
    expect(sent).toEqual([{ action: 'model', model: 'claude-sonnet-5' }]);
    await screen.unmount();
  });

  test('the bar goes stale-until-evidence off the lifecycle the control drives', async () => {
    const { api } = recorder();
    const screen = await mount(bar(api));

    await click(byLabelPrefix(screen.container, 'Switch model'));
    await click(byLabelPrefix(screen.container, 'Switch model in place to Sonnet 5'));

    // The chip says "switching" because the control called `onSwitchSubmitted`,
    // and it stays pending until the daemon observes a new model.
    expect(byLabelPrefix(screen.container, 'Switch model').getAttribute('aria-label')).toContain('switching');
    await screen.unmount();
  });

  test('opens the reasoning sheet with the Claude effort control', async () => {
    const { api, sent } = recorder();
    const screen = await mount(bar(api));

    await click(byLabelPrefix(screen.container, 'Set reasoning'));
    expect(screen.container.textContent).toContain('Reasoning effort');

    await click(byLabelPrefix(screen.container, 'Set reasoning effort to high'));
    expect(sent).toEqual([{ action: 'effort', effort: 'high' }]);
    // Claude effort is never observed, so the chip reflects what was SENT.
    expect(byLabelPrefix(screen.container, 'Set reasoning').getAttribute('aria-label')).toContain('high');
    await screen.unmount();
  });
});
