/**
 * The two first-run client steps over a REAL voice store (`createVoiceStore`: the real dictation settings store, the real
 * on-device voices, and a real speed-up key vault over in-memory records), so what is asserted is what a person's device
 * would keep, not what a prop said.
 *
 *   - a card whose engine cannot run here (unsupported browser, or no voice built in this copy) cannot be chosen: nothing is
 *     saved and the step is not answered;
 *   - "Speed-ups" answers the step only when a key was really saved, and resumes as saved after a reload.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SpeedupsStepContainer, VoiceStepContainer } from '../../../../../app/features/onboarding/step-panels.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import { ON_DEVICE_MODELS } from '../../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import { DeviceSpeedupKeys } from '../../../../../app/lib/stt/speedup-keys.ts';
import { StoreProvider, createVoiceStore, type VoiceStore } from '../../../../../app/lib/voice-store.tsx';
import { interact, mount, must, submit, typeInto } from '../../../../support/app/dom.ts';

const KEY = 'gsk_test_0123456789abcdXY';

const fakeHost = () => {
  const calls: string[] = [];
  let saving: (() => Promise<void>) | null = null;
  const host: StepHost = {
    phase: 'client',
    appliesTo: [],
    segment: {},
    remember: () => undefined,
    ready: () => void calls.push('ready'),
    skip: why => void calls.push(`skip:${why}`),
    notNeeded: () => void calls.push('notNeeded'),
    commit: next => {
      saving = next;
    },
    done: () => void calls.push('done'),
    busy: label => void calls.push(`busy:${label}`),
    next: () => void calls.push('next'),
    back: () => void calls.push('back'),
  };
  return { calls, host, save: () => saving };
};

class AbsentStore implements ModelInstaller {
  readonly totalBytes = 86_000_000;
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve({ state: 'absent' });
  }
  install(): Promise<void> {
    return new Promise(() => undefined);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

/** Every catalog engine as a voice: one that runs here (absent, installable) or one this browser cannot run. */
const catalog = (runs: boolean): OnDeviceVoices =>
  new OnDeviceVoices(
    ON_DEVICE_MODELS.map(
      model =>
        new OnDeviceVoice(
          runs
            ? {
                model,
                support: { available: true },
                store: new AbsentStore(),
                openSession: () => {
                  throw new Error('no microphone in this suite');
                },
              }
            : {
                model,
                support: { available: false, reason: 'No WebAssembly threads here.' },
                store: null,
                openSession: null,
              },
        ),
    ),
  );

const vault = () => {
  const records = new Map<string, unknown>();
  return new DeviceSpeedupKeys(
    {
      get: async slot => records.get(slot),
      put: async (slot, value) => void records.set(slot, value),
      delete: async slot => void records.delete(slot),
    },
    crypto.subtle,
    async () => Response.json({ data: [] }),
  );
};

const storeOver = (voices: OnDeviceVoices, speedupKeys: DeviceSpeedupKeys = vault()): VoiceStore =>
  createVoiceStore({ voices, speedupKeys });

const radio = (container: HTMLElement, engine: string): HTMLInputElement =>
  must(
    container.querySelector<HTMLInputElement>(`.fy-engine-card[data-engine="${engine}"] input`),
    `the ${engine} radio`,
  );

const settle = async (): Promise<void> => {
  for (let round = 0; round < 6; round += 1)
    await interact(async () => await new Promise(resolve => setTimeout(resolve, 3)));
};

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => globalThis.localStorage?.clear());

describe('<VoiceStep> over the real voice store', () => {
  for (const [name, voices] of [
    ['an unsupported browser', catalog(false)],
    ['a copy of Ferretry with no voices built in', new OnDeviceVoices([])],
  ] as const) {
    it(`cannot choose an engine in ${name}: the card is disabled, says why, and nothing is saved or answered`, async () => {
      const store = storeOver(voices);
      const { host, save } = fakeHost();
      const view = await mount(
        <StoreProvider store={store}>
          <VoiceStepContainer step={host} />
        </StoreProvider>,
      );
      await settle();
      const before = store.stt.get();
      const defaultCard = must(
        view.container.querySelector<HTMLElement>('.fy-engine-card[data-engine="parakeet-tdt-110m"]'),
        'the default card',
      );
      expect(defaultCard.textContent).toContain('Not available here');
      expect(defaultCard.dataset.disabled).toBe('true');
      const input = radio(view.container, 'parakeet-tdt-110m');
      expect(input.disabled).toBe(true);
      await interact(() => input.click());
      expect(store.stt.get()).toEqual(before);
      expect(save()).toBeNull();
      // The explanation is in the radio's own description, too, so it is spoken.
      const described = must(document.getElementById(input.getAttribute('aria-describedby') ?? ''), 'description');
      expect(described.textContent).toContain('Not available here');
      await view.unmount();
    });
  }

  it('still lets the browser voice and Off be chosen when no on-device engine can run', async () => {
    const store = storeOver(catalog(false));
    const { host, save } = fakeHost();
    const view = await mount(
      <StoreProvider store={store}>
        <VoiceStepContainer step={host} />
      </StoreProvider>,
    );
    await settle();
    await interact(() => radio(view.container, 'off').click());
    expect(store.stt.get().enabled).toBe(true);
    await interact(async () => await save()?.());
    expect(store.stt.get().enabled).toBe(false);
    await view.unmount();
  });

  it('saves the engine when Next runs the save of a supported card that was chosen', async () => {
    const store = storeOver(catalog(true));
    const { host, save } = fakeHost();
    const view = await mount(
      <StoreProvider store={store}>
        <VoiceStepContainer step={host} />
      </StoreProvider>,
    );
    await settle();
    const input = radio(view.container, 'sherpa-zipformer-en');
    expect(input.disabled).toBe(false);
    await interact(() => input.click());
    expect(store.stt.get().engine).toBeNull();
    await interact(async () => await save()?.());
    expect(store.stt.get()).toMatchObject({ enabled: true, engine: 'sherpa-zipformer-en' });
    await view.unmount();
  });
});

describe('<SpeedupsStep> over a real vault', () => {
  const draw = (store: VoiceStore, host: StepHost) => (
    <StoreProvider store={store}>
      <SpeedupsStepContainer step={host} />
    </StoreProvider>
  );

  it('answers the step once a key is really saved, never before, and not for a refused paste', async () => {
    const keys = vault();
    const store = storeOver(catalog(true), keys);
    store.stt.update({ enabled: true, engine: 'sherpa-zipformer-en' });
    const { calls, host } = fakeHost();
    const view = await mount(draw(store, host));
    await settle();
    expect(calls).toEqual(['ready']);

    const groq = must(view.container.querySelector<HTMLElement>('li[data-device-key="groq"]'), 'groq');
    await typeInto(groq.querySelector('input'), 'not a key');
    await submit(groq.querySelector('form'));
    await settle();
    expect(calls).toEqual(['ready']);

    await typeInto(groq.querySelector('input'), KEY);
    await submit(groq.querySelector('form'));
    await settle();
    expect(await keys.status('groq')).toEqual({ kind: 'saved', endsWith: 'XY' });
    expect(calls).toEqual(['ready', 'done']);
    await view.unmount();
  });

  it('resumes as saved after a reload without answering again, and a Remove does not answer either', async () => {
    const keys = vault();
    await keys.save('groq', KEY);
    const store = storeOver(catalog(true), keys);
    store.stt.update({ enabled: true, engine: 'sherpa-zipformer-en' });
    const { calls, host } = fakeHost();
    const view = await mount(draw(store, host));
    await settle();
    expect(view.container.textContent).toContain('Saved · ends with ••XY');
    expect(calls).toEqual(['ready']);
    const remove = must(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Remove the Groq key from this device"]'),
      'remove',
    );
    await interact(() => remove.click());
    await settle();
    expect(await keys.status('groq')).toEqual({ kind: 'none' });
    expect(calls).toEqual(['ready']);
    await view.unmount();
  });
});
