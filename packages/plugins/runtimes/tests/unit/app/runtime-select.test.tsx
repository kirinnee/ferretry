import { describe, expect, it } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ChosenRuntime, RuntimeSelect } from '../../../app/components/runtime-select.tsx';
import { AccountPickerStore } from '../../../app/lib/account-picker-store.ts';
import type { UsageAccountView } from '@ferretry/plugin-usage/contract';
import { interact, mount, must } from '../support/dom.ts';
import { healthMap, pickerAccount, pickerHealth } from './support/picker.ts';
import { choose, openBox, optionsOpen } from '../support/select-box.ts';

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

const host = (store: AccountPickerStore, state: Harness, extra: { usage?: UsageAccountView[] } = {}) => {
  const element = (
    <RuntimeSelect
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
      fallbackPlaceholder="runtime"
    />
  );
  return element;
};

describe('RuntimeSelect', () => {
  it('lists each runtime under its harness, and picks the first usable one when the draft names none', async () => {
    const state: Harness = { value: '', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state));
    await settle();
    await view.render(host(store, state));
    await settle();

    expect(view.container.querySelectorAll('select, input[type="radio"]'), 'no native control').toHaveLength(0);
    await openBox(view.container);
    const groups = [...document.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Claude', 'Codex']);
    expect(optionsOpen()).toHaveLength(2);
    expect(state.value).toBe('claude-a');
    await view.unmount();
  });

  it('writes the pressed runtime into the draft and tells the form which one is chosen', async () => {
    const state: Harness = { value: 'claude-a', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state));
    await settle();
    await choose(view.container, 'codex-b');
    expect(state.value).toBe('codex-b');
    await view.render(host(store, state));
    await settle();
    expect(state.chosen?.account.wrapper).toBe('codex-b');
    await view.unmount();
  });

  it('tells the form which runtimes can run a session: nothing decided before the roster is read, then the list once', async () => {
    const state: Harness = { value: '', chosen: null };
    const told: (readonly string[] | null)[] = [];
    const store = storeOf('claude-a', 'codex-b');
    const onOffered = (wrappers: readonly string[] | null): void => void told.push(wrappers);
    const element = () => <RuntimeSelect {...host(store, state).props} onOffered={onOffered} />;
    const view = await mount(element());
    await settle();
    await view.render(element());
    await settle();
    expect(told[0]).toBeNull();
    expect(told.at(-1)).toEqual(['claude-a', 'codex-b']);
    expect(told.filter(wrappers => wrappers !== null)).toHaveLength(1);
    await view.unmount();
  });

  it('says once that the first read is over', async () => {
    const state: Harness = { value: '', chosen: null };
    let settled = 0;
    const onSettled = (): void => {
      settled += 1;
    };
    const store = storeOf('claude-a');
    const element = () => <RuntimeSelect {...host(store, state).props} onSettled={onSettled} />;
    const view = await mount(element());
    await settle();
    await view.render(element());
    await settle();
    // However many times the roster is drawn again, the first read is over once.
    expect(settled).toBe(1);
    await view.unmount();
  });

  it('takes the offer back while the roster is read again, and while that read failed: a cached list is never settled', async () => {
    const state: Harness = { value: '', chosen: null };
    const told: (readonly string[] | null)[] = [];
    let reads = 0;
    let resolveRead: (accounts: string[]) => void = () => undefined;
    let rejectRead: (reason: Error) => void = () => undefined;
    const store = new AccountPickerStore({
      catalog: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve({ accounts: [pickerAccount({ wrapper: 'claude-a' })] });
        return new Promise((resolve, reject) => {
          resolveRead = accounts => resolve({ accounts: accounts.map(wrapper => pickerAccount({ wrapper })) });
          rejectRead = reject;
        });
      },
      health: async () => ({ health: healthMap(pickerHealth('login-claude-a')), error: null }),
      checkHealth: async () => ({ health: new Map(), error: null }),
    });
    const onOffered = (wrappers: readonly string[] | null): void => void told.push(wrappers);
    const element = () => <RuntimeSelect {...host(store, state).props} onOffered={onOffered} />;
    const view = await mount(element());
    await settle();
    expect(told.at(-1)).toEqual(['claude-a']);

    await interact(async () => store.reread());
    await settle();
    // The old single runtime is still on screen, but it is not the machine's answer to the read in flight.
    await openBox(view.container);
    expect(optionsOpen()).toHaveLength(1);
    await openBox(view.container); // already open: stays open
    expect(told.at(-1)).toBeNull();

    await interact(async () => resolveRead(['claude-a', 'claude-b']));
    await settle();
    expect(told.at(-1)).toEqual(['claude-a', 'claude-b']);

    await interact(async () => store.reread());
    await settle();
    await interact(async () => rejectRead(new Error('roster unavailable')));
    await settle();
    expect(told.at(-1)).toBeNull();
    await view.unmount();
  });

  it('shows health only for a login whose status was read, and quota only when the feed has a row', async () => {
    const state: Harness = { value: 'claude-a', chosen: null };
    const store = storeOf('claude-a', 'codex-b');
    const view = await mount(host(store, state, { usage: [{ agent: 'codex-b', fiveHourPercent: 80 }] }));
    await settle();
    await openBox(view.container);
    const rows = optionsOpen();
    const codex = must(
      rows.find(row => row.textContent?.includes('codex-b')),
      'codex',
    );
    expect(codex.textContent).toContain('needs sign-in');
    expect(codex.textContent).toContain('5h 80%');
    const claude = must(
      rows.find(row => row.textContent?.includes('claude-a')),
      'claude',
    );
    expect(claude.textContent).not.toContain('quota');
    expect(claude.textContent).not.toContain('5h');
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

describe('RuntimeSelect words (O12 S2)', () => {
  it('names the default model by its catalog label and never calls a terminal sign-in ready', async () => {
    const state: Harness = { value: '', chosen: null };
    const store = new AccountPickerStore({
      catalog: async () => ({
        accounts: [
          pickerAccount({
            wrapper: 'claude-a',
            defaultModel: 'claude-opus-5-5',
            credentialStore: 'host',
            models: [{ id: 'claude-opus-5-5', available: true, label: 'Opus 5.5' }],
          }),
        ],
      }),
      health: async () => ({ health: healthMap(pickerHealth('login-claude-a')), error: null }),
      checkHealth: async () => ({ health: new Map(), error: null }),
    });
    const view = await mount(host(store, state));
    await settle();
    await view.render(host(store, state));
    await settle();
    await openBox(view.container);
    const row = must(optionsOpen()[0], 'the runtime row').textContent ?? '';
    expect(row).toContain('Opus 5.5');
    expect(row).toContain('uses your terminal sign-in');
    expect(row).not.toContain('claude-opus-5-5');
    expect(row).not.toContain('ready');
    await view.unmount();
  });
});
