import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { type DaemonConnection, daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  createAppStore,
  StoreProvider,
  useAddKeyStepUp,
  useApprovePasteRuleStepUp,
  useApproveSignInRuleStepUp,
  useApproveTaskPlanStepUp,
  useStepUpRequest,
} from '../../src/lib/store.tsx';
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

type ApproveTaskPlan = ReturnType<typeof useApproveTaskPlanStepUp>;

function ApproveTaskPlanProbe({ onAsk }: { readonly onAsk: (ask: ApproveTaskPlan) => void }) {
  onAsk(useApproveTaskPlanStepUp());
  return null;
}

describe('useApproveTaskPlanStepUp', () => {
  it('is no prompt at all outside the app’s store', async () => {
    let ask: ApproveTaskPlan = () => Promise.resolve(true);
    const view = await mount(<ApproveTaskPlanProbe onAsk={value => (ask = value)} />);

    expect(ask).toBeUndefined();
    await view.unmount();
  });

  it('asks the one prompt for the approve-task-plan act, bound to the stage, with the daemon’s words', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    let ask: ApproveTaskPlan;
    const view = await mount(
      <StoreProvider store={store}>
        <ApproveTaskPlanProbe onAsk={value => (ask = value)} />
      </StoreProvider>,
    );

    const answer = ask?.(alpha, `tps_${'a'.repeat(24)}` as never, {
      does: 'Let the ferret use this line without asking',
      rows: [{ label: 'Line 2', value: 'sign in to vercel.com' }],
      warnings: [],
    });

    expect(store.stepUp.snapshot()?.acts).toEqual(['Let the ferret use this line without asking']);
    store.stepUp.dismiss();
    expect(await answer).toBe(false);
    await view.unmount();
  });
});

type ApproveSignInRule = ReturnType<typeof useApproveSignInRuleStepUp>;

function ApproveSignInRuleProbe({ onAsk }: { readonly onAsk: (ask: ApproveSignInRule) => void }) {
  onAsk(useApproveSignInRuleStepUp());
  return null;
}

describe('useApproveSignInRuleStepUp', () => {
  it('is no prompt at all outside the app’s store', async () => {
    let ask: ApproveSignInRule = () => Promise.resolve(true);
    const view = await mount(<ApproveSignInRuleProbe onAsk={value => (ask = value)} />);

    expect(ask).toBeUndefined();
    await view.unmount();
  });

  it('asks the one prompt for the approve-sign-in-rule act, bound to the stage, with the words as structure', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    let ask: ApproveSignInRule;
    const view = await mount(
      <StoreProvider store={store}>
        <ApproveSignInRuleProbe onAsk={value => (ask = value)} />
      </StoreProvider>,
    );
    const words = {
      does: 'Ferretry types your sudo password for any ferret on kirin-box, without asking.',
      rows: [{ label: 'Who', value: 'any ferret' }],
      warnings: ['Any ferret on this machine gets root while this rule lasts.'],
    };

    const answer = ask?.(alpha, `srs_${'a'.repeat(24)}` as never, words);

    const prompt = store.stepUp.snapshot();
    expect(prompt?.acts).toEqual([words.does]);
    expect(prompt?.words).toEqual(words);
    store.stepUp.dismiss();
    expect(await answer).toBe(false);
    await view.unmount();
  });
});

type ApprovePasteRule = ReturnType<typeof useApprovePasteRuleStepUp>;

function ApprovePasteRuleProbe({ onAsk }: { readonly onAsk: (ask: ApprovePasteRule) => void }) {
  onAsk(useApprovePasteRuleStepUp());
  return null;
}

describe('useApprovePasteRuleStepUp', () => {
  it('is no prompt at all outside the app’s store', async () => {
    let ask: ApprovePasteRule = () => Promise.resolve(true);
    const view = await mount(<ApprovePasteRuleProbe onAsk={value => (ask = value)} />);

    expect(ask).toBeUndefined();
    await view.unmount();
  });

  it('asks the one prompt for the act it is given, bound to the stage, with the daemon rows as structure', async () => {
    const store = await createAppStore({
      repository: new MemoryRepository(),
      connectClient: async () => ({}) as unknown as FyApiClient,
      fetcher: async () => Response.json({}),
    });
    let ask: ApprovePasteRule;
    const view = await mount(
      <StoreProvider store={store}>
        <ApprovePasteRuleProbe onAsk={value => (ask = value)} />
      </StoreProvider>,
    );
    const words = {
      does: 'Ferretry pastes what gh prints into vercel in a terminal, for any ferret on this machine, without asking.',
      rows: [{ label: 'Staged', value: 'At this machine, 2026-11-02 09:00 UTC' }],
      warnings: [],
    };

    const answer = ask?.(alpha, `prs_${'a'.repeat(24)}` as never, words, 'allow-profile-targets');

    const prompt = store.stepUp.snapshot();
    expect(prompt?.acts).toEqual([words.does]);
    expect(prompt?.words).toEqual(words);
    expect(prompt?.bound).toBe(true);
    store.stepUp.dismiss();
    expect(await answer).toBe(false);
    await view.unmount();
  });
});

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
