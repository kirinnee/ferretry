import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { createAppStore, StoreProvider, useAddKeyStepUp, useStepUpRequest } from '../../src/lib/store.tsx';
import { mount } from '../support/dom.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-token' });

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

type Ask = ((daemon: DaemonConnection) => Promise<boolean>) | undefined;

function Probe({ onAsk }: { readonly onAsk: (ask: Ask) => void }) {
  onAsk(useStepUpRequest());
  return null;
}

type AddKey = ReturnType<typeof useAddKeyStepUp>;

function AddKeyProbe({ onAsk }: { readonly onAsk: (ask: AddKey) => void }) {
  onAsk(useAddKeyStepUp());
  return null;
}

describe('useAddKeyStepUp', () => {
  it('is no prompt at all outside the app’s store', async () => {
    let ask: AddKey = () => Promise.resolve(true);
    const view = await mount(<AddKeyProbe onAsk={value => (ask = value)} />);

    expect(ask).toBeUndefined();
    await view.unmount();
  });

  it('asks the app’s one prompt, with the words the daemon’s own account list made', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    let ask: AddKey;
    const view = await mount(
      <StoreProvider store={store}>
        <AddKeyProbe onAsk={value => (ask = value)} />
      </StoreProvider>,
    );

    const answer = ask?.(alpha, `st_${'a'.repeat(24)}` as never, 'save automatic codes to GitHub · kirinnee');

    expect(store.stepUp.snapshot()?.acts).toEqual(['save automatic codes to GitHub · kirinnee']);
    store.stepUp.dismiss();
    expect(await answer).toBe(false);
    await view.unmount();
  });
});

describe('useStepUpRequest', () => {
  it('asks the app’s one step-up prompt, so a screen never owns a second prompt', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    let ask: Ask;
    const view = await mount(
      <StoreProvider store={store}>
        <Probe onAsk={value => (ask = value)} />
      </StoreProvider>,
    );
    const answer = ask?.(alpha);
    expect(store.stepUp.snapshot()?.daemon.daemonId).toBe(alpha.daemonId);
    store.stepUp.dismiss();
    expect(await answer).toBe(false);
    await view.unmount();
  });

  it('gives presence its own prompt, apart from the step-up one', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    const answer = store.unlockGate.require(alpha);
    expect(store.unlockGate.snapshot()?.daemon.daemonId).toBe(alpha.daemonId);
    expect(store.stepUp.snapshot()).toBeNull();
    store.unlockGate.dismiss();
    expect(await answer).toBe(false);
  });

  it('says the machine’s own unlock hours on the unlock prompt, and a plain fallback when it cannot be read', async () => {
    const answering = async (settings: unknown): Promise<string | undefined> => {
      const store = await createAppStore({
        repository: new MemoryRepository(),
        connectClient: async () =>
          ({
            request: async (_path: string, schema: { parse: (value: unknown) => unknown }) => {
              if (settings === undefined) throw new Error('unreadable');
              return schema.parse(settings);
            },
          }) as unknown as FyApiClient,
        fetcher: async () => Response.json({}),
      });
      void store.unlockGate.require(alpha);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      const scope = store.unlockGate.snapshot()?.scope;
      store.unlockGate.dismiss();
      return scope;
    };

    expect(
      await answering({
        settings: {
          unlockOnOpen: true,
          unlockValidityHours: 12,
          stepUpOnActions: false,
          stepUpWindowMinutes: 15,
          deviceKeyRotationDays: 30,
          idleExpiryDays: 30,
        },
        source: 'document',
        mayWiden: false,
        widenCommand: 'x',
      }),
    ).toBe('It stays unlocked on this device for 12 hours.');
    expect(await answering(undefined)).toBe(
      'It stays unlocked on this device for a few hours, as this machine is set.',
    );
  });

  it('offers nothing outside the app store, so no control is rendered that could never be answered', async () => {
    let ask: Ask = async () => true;
    const view = await mount(<Probe onAsk={value => (ask = value)} />);
    expect(ask).toBeUndefined();
    await view.unmount();
  });
});
