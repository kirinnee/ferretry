/**
 * THE "WHICH AI" PAGE: Claude ticked first, Codex, Gemini shown but not pickable, Others opening the catalog's providers, each
 * ticked provider asking "Which harness runs it?". Choosing writes nothing: the page only remembers, in the run's memory.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { StepHost } from '@ferretry/kernel/contract';
import { AgentsPage } from '../../../app/features/agents/agents-page.tsx';
import type { Provider } from '../../../app/features/agents/agents-model.ts';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const PROVIDERS: readonly Provider[] = [
  { id: 'alpha-ai', label: 'Alpha AI', harnesses: ['claude'] },
  { id: 'beta-ai', label: 'Beta AI', harnesses: ['claude', 'codex'] },
];

const fakeStep = () => {
  const calls: string[] = [];
  const memory: Record<string, unknown> = {};
  const step = {
    ready: () => calls.push('ready'),
    segment: memory,
    remember: (patch: Record<string, unknown>) => Object.assign(memory, patch),
    done: () => calls.push('done'),
    skip: () => calls.push('skip'),
    notNeeded: () => calls.push('notNeeded'),
    commit: () => calls.push('commit'),
    busy: () => calls.push('busy'),
  } as unknown as StepHost;
  return { step, calls, memory };
};

const mountPage = async (read: () => Promise<readonly Provider[]> = async () => PROVIDERS) => {
  const fake = fakeStep();
  view = await mount(<AgentsPage step={fake.step} readProviders={read} />);
  return fake;
};

const box = (name: string): HTMLInputElement =>
  must(view?.container.querySelector<HTMLInputElement>(`[data-agent-row="${name}"] > label input`), name);

describe('Which AI do you want to use?', () => {
  it('lists Claude first and ticked, then Codex, Gemini (coming, not pickable) and Others', async () => {
    await mountPage();
    const rows = [...must(view?.container, 'page').querySelectorAll('[data-agent-row]')].map(row =>
      row.getAttribute('data-agent-row'),
    );
    expect(rows).toEqual(['claude', 'codex', 'gemini', 'others']);
    expect(box('claude').checked).toBe(true);
    expect(box('codex').checked).toBe(false);
    expect(box('gemini').disabled).toBe(true);
    expect(view?.container.querySelector('[data-agent-coming]')?.textContent).toBe('Coming');
  });

  it('says it is ready at once, and remembers Claude only: nothing is written by drawing it', async () => {
    const { calls, memory } = await mountPage();
    expect(calls).toEqual(['ready']);
    expect(memory).toMatchObject({ agentsOn: 'claude-code', agentsOff: 'codex' });
  });

  it('remembers each tick in the order the run walks them', async () => {
    const { memory } = await mountPage();
    await interact(() => box('codex').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code,codex', agentsOff: '' });
    await interact(() => box('claude').click());
    expect(memory).toMatchObject({ agentsOn: 'codex', agentsOff: 'claude-code' });
  });

  it('Others opens the catalog providers; a ticked provider asks which harness runs it, only from its own halves', async () => {
    const { memory } = await mountPage();
    expect(view?.container.querySelector('[data-agent-providers]')).toBeNull();
    await interact(() => box('others').click());
    const list = must(view?.container.querySelector('[data-agent-providers]'), 'the providers');
    expect([...list.querySelectorAll('[data-agent-row]')].map(row => row.getAttribute('data-agent-row'))).toEqual([
      'provider-alpha-ai',
      'provider-beta-ai',
    ]);
    expect(list.querySelector('[data-agent-harness]')).toBeNull();
    await interact(() => box('provider-beta-ai').click());
    const harness = must(list.querySelector('[data-agent-harness="beta-ai"]'), 'the harness choice');
    expect([...harness.querySelectorAll('input')].map(input => input.value)).toEqual(['claude', 'codex']);
    await interact(() => must(harness.querySelectorAll<HTMLInputElement>('input')[1], 'codex').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code,codex', agentsOff: '' });
  });

  it('untick Others drops its providers from the pick', async () => {
    const { memory } = await mountPage();
    await interact(() => box('claude').click());
    await interact(() => box('others').click());
    await interact(() => box('provider-beta-ai').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code', agentsOff: 'codex' });
    await interact(() => box('others').click());
    expect(memory).toMatchObject({ agentsOn: '', agentsOff: 'claude-code,codex' });
  });

  it('a catalog that cannot be read says so and offers to try again', async () => {
    let attempts = 0;
    await mountPage(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('down');
      return PROVIDERS;
    });
    await interact(() => box('others').click());
    expect(view?.container.querySelector('[data-agent-providers-failed]')).not.toBeNull();
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agent-providers-failed] button'), 'retry').click(),
    );
    expect(view?.container.querySelector('[data-agent-providers-failed]')).toBeNull();
    expect(attempts).toBe(2);
  });
});
