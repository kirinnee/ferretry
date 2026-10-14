import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import { createAppStore, StoreProvider, useStepUpRequest } from '../../src/lib/store.tsx';
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

  it('offers nothing outside the app store, so no control is rendered that could never be answered', async () => {
    let ask: Ask = async () => true;
    const view = await mount(<Probe onAsk={value => (ask = value)} />);
    expect(ask).toBeUndefined();
    await view.unmount();
  });
});
