/**
 * THE "WHICH AI" PAGE: the installed harnesses (Claude Code ticked first), Google shown but not pickable, Others opening the catalog's providers, each
 * ticked provider asking "Which harness runs it?". Choosing writes nothing: the page only remembers, in the run's memory.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { StepHost } from '@ferretry/kernel/contract';
import { AgentsPage } from '../../../app/features/agents/agents-page.tsx';
import type { Harness, Provider } from '../../../app/features/agents/agents-model.ts';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

/** What the daemon's registry says is installed. */
const INSTALLED: readonly Harness[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
];

const PROVIDERS: readonly Provider[] = [
  { id: 'alpha-ai', label: 'Alpha AI', harnesses: ['claude-code'] },
  { id: 'beta-ai', label: 'Beta AI', harnesses: ['claude-code', 'codex'] },
];

const held: { save: (() => Promise<void>) | null } = { save: null };

const fakeStep = () => {
  held.save = null;
  const calls: string[] = [];
  const memory: Record<string, unknown> = {};
  const step = {
    ready: () => calls.push('ready'),
    segment: memory,
    remember: (patch: Record<string, unknown>) => Object.assign(memory, patch),
    done: () => calls.push('done'),
    skip: () => calls.push('skip'),
    notNeeded: () => calls.push('notNeeded'),
    commit: (save: (() => Promise<void>) | null) => {
      calls.push(save === null ? 'commit:clear' : 'commit:hold');
      held.save = save;
    },
    busy: () => calls.push('busy'),
  } as unknown as StepHost;
  return { step, calls, memory };
};

const mountPage = async (
  read: () => Promise<readonly Provider[]> = async () => PROVIDERS,
  installed: readonly Harness[] = INSTALLED,
) => {
  const fake = fakeStep();
  view = await mount(<AgentsPage step={fake.step} readHarnesses={async () => installed} readProviders={read} />);
  return fake;
};

const box = (name: string): HTMLInputElement =>
  must(view?.container.querySelector<HTMLInputElement>(`[data-agent-row="${name}"] > label input`), name);

describe('Which AI do you want to use?', () => {
  it('lists the installed harnesses, Claude Code first and ticked, then Google (coming, not pickable) and Others', async () => {
    await mountPage();
    const rows = [...must(view?.container, 'page').querySelectorAll('[data-agent-row]')].map(row =>
      row.getAttribute('data-agent-row'),
    );
    expect(rows).toEqual(['claude-code', 'codex', 'google', 'others']);
    expect(box('claude-code').checked).toBe(true);
    expect(box('codex').checked).toBe(false);
    expect(box('google').disabled).toBe(true);
    expect(view?.container.querySelector('[data-agent-row="google"]')?.textContent).toContain(
      'Google (Antigravity CLI)',
    );
    expect(view?.container.querySelector('[data-agent-coming]')?.textContent).toBe('Coming');
  });

  it('shows what was found on this computer beside the harness found, and nothing beside Google', async () => {
    const fake = fakeStep();
    view = await mount(
      <AgentsPage
        step={fake.step}
        readHarnesses={async () => INSTALLED}
        readProviders={async () => PROVIDERS}
        found={{ 'claude-code': { ready: true } }}
      />,
    );
    const noted = [...(view?.container.querySelectorAll('[data-agent-found]') ?? [])].map(note =>
      note.closest('[data-agent-row]')?.getAttribute('data-agent-row'),
    );
    expect(noted).toEqual(['claude-code']);
    expect(fake.calls).toEqual(['ready']);
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
    await interact(() => box('claude-code').click());
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
    expect([...harness.querySelectorAll('input')].map(input => input.value)).toEqual(['claude-code', 'codex']);
    await interact(() => must(harness.querySelectorAll<HTMLInputElement>('input')[1], 'codex').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code,codex', agentsOff: '' });
  });

  it('untick Others drops its providers from the pick', async () => {
    const { memory } = await mountPage();
    await interact(() => box('claude-code').click());
    await interact(() => box('others').click());
    await interact(() => box('provider-beta-ai').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code', agentsOff: 'codex' });
    await interact(() => box('others').click());
    expect(memory).toMatchObject({ agentsOn: '', agentsOff: 'claude-code,codex' });
  });

  it('an empty pick holds Next with a clear message and says so; a pick lets it through again', async () => {
    const { calls } = await mountPage();
    await interact(() => box('claude-code').click());
    expect(calls).toEqual(['ready', 'commit:hold']);
    expect(view?.container.querySelector('[data-agent-none]')?.textContent).toContain('at least one');
    await expect(held.save?.()).rejects.toThrow('at least one');
    await interact(() => box('codex').click());
    expect(calls).toEqual(['ready', 'commit:hold', 'commit:clear']);
    expect(view?.container.querySelector('[data-agent-none]')).toBeNull();
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

describe("the list is the registry's, not the page's", () => {
  it('lists a third installed harness, in registry order after Claude Code and Codex, and ticks only Claude Code', async () => {
    const { memory } = await mountPage(undefined, [
      { key: 'fake-third', label: 'Fake Third' },
      { key: 'codex', label: 'Codex' },
      { key: 'claude-code', label: 'Claude Code' },
    ]);
    const rows = [...must(view?.container, 'page').querySelectorAll('[data-agent-row]')].map(row =>
      row.getAttribute('data-agent-row'),
    );
    expect(rows).toEqual(['claude-code', 'fake-third', 'codex', 'google', 'others']);
    expect(box('fake-third').checked).toBe(false);
    expect(memory).toMatchObject({ agentsOn: 'claude-code', agentsOff: 'fake-third,codex' });
    await interact(() => box('fake-third').click());
    expect(memory).toMatchObject({ agentsOn: 'claude-code,fake-third', agentsOff: 'codex' });
  });

  it('drops the Google placeholder once an installed harness covers it', async () => {
    await mountPage(undefined, [...INSTALLED, { key: 'antigravity', label: 'Antigravity' }]);
    expect(view?.container.querySelector('[data-agent-row="google"]')).toBeNull();
    expect(view?.container.querySelector('[data-agent-row="antigravity"]')).not.toBeNull();
  });

  it('draws nothing to pick until the installed harnesses are known, then says it is ready', async () => {
    const fake = fakeStep();
    let release: (list: readonly Harness[]) => void = () => undefined;
    view = await mount(
      <AgentsPage
        step={fake.step}
        readHarnesses={() => new Promise<readonly Harness[]>(resolve => (release = resolve))}
        readProviders={async () => PROVIDERS}
      />,
    );
    expect(view?.container.querySelector('[data-agent-row]')).toBeNull();
    expect(view?.container.querySelector('[data-agent-harnesses-reading]')).not.toBeNull();
    expect(fake.calls).toEqual([]);
    await interact(() => release(INSTALLED));
    expect(view?.container.querySelector('[data-agent-row="claude-code"]')).not.toBeNull();
    expect(fake.calls).toEqual(['ready']);
  });

  it('says so and offers to try again when the installed harnesses cannot be read', async () => {
    const fake = fakeStep();
    let attempts = 0;
    view = await mount(
      <AgentsPage
        step={fake.step}
        readHarnesses={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('down');
          return INSTALLED;
        }}
        readProviders={async () => PROVIDERS}
      />,
    );
    expect(view?.container.querySelector('[data-agent-harnesses-failed]')).not.toBeNull();
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agent-harnesses-failed] button'), 'retry').click(),
    );
    expect(view?.container.querySelector('[data-agent-row="claude-code"]')).not.toBeNull();
    expect(attempts).toBe(2);
  });
});
