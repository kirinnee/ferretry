import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ChosenRuntime, RuntimeButtons } from '../../../app/components/runtime-buttons.tsx';
import { AccountPickerStore } from '../../../app/lib/account-picker-store.ts';
import type { AccountUsageRow } from '../../../app/lib/daemon-picker-model.ts';
import { interact, mount, must } from '../support/dom.ts';
import { healthMap, pickerAccount, pickerHealth } from './support/picker.ts';

const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const client = { subscribe: () => () => undefined } as unknown as Pick<PluginClient, 'subscribe'>;

const storeOf = (...wrappers: string[]) =>
  new AccountPickerStore({
    catalog: async () => ({ accounts: wrappers.map(wrapper => pickerAccount({ wrapper })) }),
    health: async () => ({
      health: healthMap(pickerHealth('login-codex-b', 'needs_sign_in'), pickerHealth('login-claude-a')),
      error: null,
    }),
    checkHealth: async () => ({ health: new Map(), error: null }),
  });

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

interface Harness {
  value: string;
  chosen: ChosenRuntime | null;
}

const host = (store: AccountPickerStore, state: Harness, extra: { usage?: AccountUsageRow[] } = {}) => {
  const element = (
    <RuntimeButtons
      store={store}
      client={client}
      now={NOW}
      usage={extra.usage ?? []}
      usageError={null}
      value={state.value}
      onValueChange={next => {
        state.value = next;
      }}
      onChosen={chosen => {
        state.chosen = chosen;
      }}
      noAccounts={<p data-none="">No runtimes</p>}
      fallbackId="fb"
      labelId="lbl"
      fallbackPlaceholder="runtime"
    />
  );
  return element;
};

describe('RuntimeButtons', () => {
  it('draws one radio per runtime under its harness, and picks the first usable one when the draft names none', async () => {
    const state: Harness = { value: '', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state));
    await settle();
    await view.render(host(store, state));
    await settle();

    const groups = [...view.container.querySelectorAll('[data-runtime-group]')].map(group =>
      group.getAttribute('data-runtime-group'),
    );
    expect(groups).toEqual(['claude-code', 'codex']);
    expect(view.container.querySelectorAll('[data-runtime-option]')).toHaveLength(2);
    expect(state.value).toBe('claude-a');
    await view.unmount();
  });

  it('writes the pressed runtime into the draft and tells the form which one is chosen', async () => {
    const state: Harness = { value: 'claude-a', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state));
    await settle();
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('[data-runtime-option="codex-b"] input'), 'codex').click(),
    );
    expect(state.value).toBe('codex-b');
    await view.render(host(store, state));
    await settle();
    expect(state.chosen?.account.wrapper).toBe('codex-b');
    await view.unmount();
  });

  it('shows health only for a login whose status was read, and quota only when the feed has a row', async () => {
    const state: Harness = { value: 'claude-a', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state, { usage: [{ agent: 'codex-b', fiveHourPercent: 80 }] }));
    await settle();
    const codex = must(view.container.querySelector('[data-runtime-option="codex-b"]'), 'codex');
    expect(codex.textContent).toContain('needs sign-in');
    expect(codex.textContent).toContain('5h 80%');
    const claude = must(view.container.querySelector('[data-runtime-option="claude-a"]'), 'claude');
    expect(claude.textContent).not.toContain('quota');
    await view.unmount();
  });

  it('says what to do when the machine has no runtime, and falls back to a typed name when the roster cannot be read', async () => {
    const empty = await mount(host(storeOf(), { value: '', chosen: null }));
    await settle();
    expect(empty.container.querySelector('[data-none]')).not.toBeNull();
    await empty.unmount();

    const broken = new AccountPickerStore({
      catalog: async () => {
        throw new Error('runtimes unavailable');
      },
      health: async () => ({ health: new Map(), error: null }),
      checkHealth: async () => ({ health: new Map(), error: null }),
    });
    const view = await mount(host(broken, { value: '', chosen: null }));
    await settle();
    expect(view.container.querySelector('input#fb')).not.toBeNull();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('runtimes unavailable');
    await view.unmount();
  });
});
