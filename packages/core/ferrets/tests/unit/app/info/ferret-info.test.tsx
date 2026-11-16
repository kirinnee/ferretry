/**
 * Info as a header panel: the ⓘ opens it, every read goes through the client by route key and starts when its tab is
 * first shown, and a refusal or an unreadable body says so rather than drawing a claim about the ferret.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { PanelProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createInfoPanel } from '../../../../app/views/info.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { type Call, scripted } from '../support/client.ts';
import { ferretOf } from './fixtures.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const ANSWERS = {
  'GET /v1/ferrets/:ferretId': ferretOf('f1', {
    name: 'hadi',
    title: 'Fix the login bug',
    model: 'opus',
    runtime: 'nero',
  }),
  'GET /v1/ferrets': [ferretOf('f1'), ferretOf('c1', { name: 'sol', parent: 'f1' })],
  'GET /v1/worktrees': { worktrees: [] },
  'GET /v1/ferrets/:ferretId/relaunch-settings': { current: false, reasons: ['settings'] },
  'POST /v1/ferrets/:ferretId/move': ferretOf('f1', { name: 'hadi', runtime: 'nero' }),
};

const open = async (routes: Record<string, unknown> = ANSWERS, calls: Call[] = []) => {
  const Panel = createInfoPanel(scripted(routes, calls)) as ComponentType<PanelProps>;
  mounted = await mount(<Panel {...({ subject: 'f1' } satisfies PanelProps)} />);
  const root = mounted.container;
  await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-toggle]'), 'the ⓘ').click());
  await settle();
  return { root, calls };
};

describe('the info panel', () => {
  it('draws nothing without a ferret, and reads nothing until opened', async () => {
    const calls: Call[] = [];
    const Panel = createInfoPanel(scripted(ANSWERS, calls)) as ComponentType<PanelProps>;
    mounted = await mount(<Panel />);
    expect(mounted.container.textContent).toBe('');
    await mounted.unmount();
    mounted = await mount(<Panel subject="f1" />);
    expect(mounted.container.querySelector('[data-info-toggle]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-info-panel]')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('opens on Overview with the ferret, its sub-ferrets and the worktree read by route key', async () => {
    const { root, calls } = await open();
    expect(root.querySelector('.fy-info__name')?.textContent).toBe('Hadi');
    expect(root.querySelector('[data-info-row="Task"] dd')?.textContent).toBe('Fix the login bug');
    expect(root.querySelector('[data-info-row="Worktree"] dd')?.textContent).toBe('Main checkout');
    expect(root.querySelectorAll('[data-sub-ferret]').length).toBe(1);
    expect(calls.map(call => call.route).sort()).toEqual([
      'GET /v1/ferrets',
      'GET /v1/ferrets/:ferretId',
      'GET /v1/worktrees',
    ]);
  });

  it('reads the relaunch dial only when Runtime is shown, and restarts through the same move as Actions', async () => {
    const { root, calls } = await open();
    expect(calls.some(call => call.route.endsWith('relaunch-settings'))).toBe(false);
    const runtime = must(
      [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Runtime'),
      'the Runtime tab',
    );
    await interact(() => runtime.click());
    await settle();
    expect(root.querySelector('[data-info-row="Model"] dd')?.textContent).toBe('opus');
    expect(root.querySelector('[data-info-settings="stale"]')).not.toBeNull();

    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    await settle();
    expect(calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/move')?.body).toMatchObject({
      agent: 'nero',
      forceInflight: false,
    });
    expect(root.querySelector('[data-info-settings="restarted"]')).not.toBeNull();
  });

  it('never shows Restarted when the daemon paused the restart, and holds the pause with Restart anyway', async () => {
    const paused = Object.assign(new Error('There is no recorded conversation to resume.'), {
      status: 409,
      code: 'conversation_unresumable',
    });
    const { root, calls } = await open({ ...ANSWERS, 'POST /v1/ferrets/:ferretId/move': paused });
    const runtime = must(
      [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Runtime'),
      'the Runtime tab',
    );
    await interact(() => runtime.click());
    await settle();
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    await settle();
    expect(root.querySelector('[data-info-settings="restarted"]')).toBeNull();
    expect(root.textContent).not.toContain('Restarted');
    expect(root.querySelector('[data-restart-unresumable]')).not.toBeNull();
    expect(root.textContent).toContain('There is no recorded conversation to resume.');
    // The row is still offering the Restart: nothing was claimed as done.
    expect(root.querySelector('[data-info-settings="stale"]')).not.toBeNull();
    expect(calls.filter(call => call.route.endsWith('/move'))).toHaveLength(1);
  });

  it('says a failed restart in words and does not claim it', async () => {
    const down = new Error('the pane is gone');
    const { root } = await open({ ...ANSWERS, 'POST /v1/ferrets/:ferretId/move': down });
    const runtime = must(
      [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'Runtime'),
      'the Runtime tab',
    );
    await interact(() => runtime.click());
    await settle();
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart').click());
    await settle();
    expect(root.textContent).toContain('Couldn’t restart: the pane is gone');
    expect(root.querySelector('[data-info-settings="restarted"]')).toBeNull();
  });

  it('closes through its ×', async () => {
    const { root } = await open();
    await interact(() => must(root.querySelector<HTMLButtonElement>('[data-info-close]'), 'close').click());
    expect(root.querySelector('[data-info-panel]')).toBeNull();
  });

  it('says a refused read in the daemon’s words and draws no ferret', async () => {
    const refusal = Object.assign(new Error('no ferret f1'), { status: 404 });
    const { root } = await open({ ...ANSWERS, 'GET /v1/ferrets/:ferretId': refusal });
    expect(root.textContent).toContain('Couldn’t read this ferret: no ferret f1');
    expect(root.querySelector('[data-info-row]')).toBeNull();
  });

  it('keeps Overview drawn when only the worktree list cannot be read', async () => {
    const { root } = await open({ ...ANSWERS, 'GET /v1/worktrees': new Error('git is unavailable') });
    expect(root.querySelector('[data-info-row="Worktree"] dd')?.textContent).toBe('Unknown');
    expect(root.querySelector('[data-info-row="Folder"]')).not.toBeNull();
  });
});
