/**
 * "<Tool> is ready" (O9-6): the last page of a harness segment says what the pick ended with, from the machine's runtimes.
 * What is asserted is what the person reads (ready / cannot start / none made / unreadable), that the page reads the machine
 * afresh, and that it tells the shell it is ready (so it never hangs under the loading cover).
 */
import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  RuntimeReadyPage,
  readyStateOf,
  type ReadyRuntime,
} from '../../../../../app/features/import-kit/runtime-ready.tsx';
import { interact, mount } from '../../../support/dom.ts';

const runtime = (
  harness: string,
  name: string,
  launch: ReadyRuntime['launch'] = { available: true },
): ReadyRuntime => ({
  id: name,
  name,
  harness,
  launch,
});

describe('readyStateOf', () => {
  it('is ready with the names of the harness’s runtimes that can start, and ignores other tools', () => {
    const state = readyStateOf(
      [runtime('codex', 'codex-a'), runtime('claude-code', 'claude-a'), runtime('claude-code', 'claude-b')],
      'claude-code',
    );
    expect(state).toEqual({ kind: 'ready', names: ['claude-a', 'claude-b'] });
  });
  it('is blocked, with the daemon’s reason, when the only runtime cannot start', () => {
    expect(
      readyStateOf([runtime('codex', 'codex-a', { available: false, reason: 'Sign in to launch' })], 'codex'),
    ).toEqual({
      kind: 'blocked',
      name: 'codex-a',
      reason: 'Sign in to launch',
    });
  });
  it('is none when the harness has no runtime', () => {
    expect(readyStateOf([runtime('codex', 'codex-a')], 'claude-code')).toEqual({ kind: 'none' });
    expect(readyStateOf([], 'codex')).toEqual({ kind: 'none' });
  });
});

/** A step host that only records whether the page said it is ready (the shell lifts its loading cover on that). */
const stepHarness = () => {
  let shown = false;
  const host = {
    ready: () => (shown = true),
    skip: () => undefined,
    notNeeded: () => undefined,
    done: () => undefined,
    busy: () => undefined,
    remember: () => undefined,
    commit: () => undefined,
    next: () => undefined,
    back: () => undefined,
    phase: 'daemon',
    appliesTo: [],
    segment: {},
  } as unknown as StepHost;
  return {
    host,
    get decision() {
      return shown ? 'shown' : 'undecided';
    },
  };
};
const settle = () => interact(() => new Promise(resolve => setTimeout(resolve, 20)));
const clientOf = (answers: (() => unknown)[]) => {
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      call: async (route: string) => {
        if (route !== 'GET /v1/runtimes') throw new Error(`unexpected route ${route}`);
        reads += 1;
        const next = answers.length > 1 ? answers.shift() : answers[0];
        const value = next?.();
        if (value instanceof Error) throw value;
        return value;
      },
    } as unknown as Pick<PluginClient, 'call'>,
  };
};

describe('RuntimeReadyPage', () => {
  it('says the tool is ready and names its runtime; the shell is told it is ready', async () => {
    const harness = stepHarness();
    const { client } = clientOf([() => ({ runtimes: [runtime('claude-code', 'Claude (atomi)')] })]);
    const view = await mount(
      createElement(RuntimeReadyPage, { client, harness: 'claude-code', label: 'Claude Code', step: harness.host }),
    );
    await settle();
    expect(view.container.querySelector('[data-runtime-ready]')?.getAttribute('data-runtime-ready')).toBe('ready');
    expect(view.container.querySelector('[data-ready-headline]')?.textContent).toBe('Claude Code is ready');
    expect(view.container.querySelector('[data-ready-names]')?.textContent).toBe('Runtime: Claude (atomi).');
    expect(harness.decision).toBe('shown');
    await view.unmount();
  });

  it('says plainly that no runtime was made, and where to add one later, when the sign-in was skipped', async () => {
    const harness = stepHarness();
    const { client } = clientOf([() => ({ runtimes: [runtime('claude-code', 'claude-a')] })]);
    const view = await mount(
      createElement(RuntimeReadyPage, { client, harness: 'codex', label: 'Codex', step: harness.host }),
    );
    await settle();
    expect(view.container.querySelector('[data-ready-headline]')?.textContent).toBe('No runtime was made for Codex');
    expect(view.container.querySelector('[data-ready-later]')?.textContent).toContain('Settings › Logins');
    expect(view.container.querySelector('[data-runtime-ready]')?.getAttribute('data-runtime-ready')).toBe('none');
    expect(harness.decision).toBe('shown');
    await view.unmount();
  });

  it('says a runtime cannot start yet, with the reason', async () => {
    const { client } = clientOf([
      () => ({ runtimes: [runtime('codex', 'codex-a', { available: false, reason: 'Sign in to launch' })] }),
    ]);
    const view = await mount(
      createElement(RuntimeReadyPage, { client, harness: 'codex', label: 'Codex', step: stepHarness().host }),
    );
    await settle();
    expect(view.container.querySelector('[data-ready-headline]')?.textContent).toBe(
      'Codex has a runtime, but it cannot start yet',
    );
    expect(view.container.querySelector('[data-ready-names]')?.textContent).toContain('Sign in to launch');
    await view.unmount();
  });

  it('an unreadable machine says so, still shows the page, and Try again reads it afresh', async () => {
    const harness = stepHarness();
    const { client, reads } = clientOf([
      () => new Error('unreachable'),
      () => ({ runtimes: [runtime('codex', 'codex-a')] }),
    ]);
    const view = await mount(
      createElement(RuntimeReadyPage, { client, harness: 'codex', label: 'Codex', step: harness.host }),
    );
    await settle();
    expect(view.container.querySelector('[data-runtime-ready]')?.getAttribute('data-runtime-ready')).toBe('unread');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('could not read the runtimes');
    expect(harness.decision).toBe('shown');
    const retry = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'Try again');
    await interact(() => retry?.click());
    await settle();
    expect(reads()).toBe(2);
    expect(view.container.querySelector('[data-ready-headline]')?.textContent).toBe('Codex is ready');
    await view.unmount();
  });
});
