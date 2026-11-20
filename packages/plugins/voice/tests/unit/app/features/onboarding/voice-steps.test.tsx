/**
 * The two first-run client steps, against a fake `StepHost` that records what the shell would hear:
 * `ready` once the page can draw, `skip` when it has nothing to say, `commit` for what Next must save (nothing is written by a
 * pick), `done` when a key was saved, `busy` while a download runs.
 */

import { describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { SpeedupsStep, needsSpeedups } from '../../../../../app/features/onboarding/speedups-step.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import {
  choiceOf,
  patchFor,
  shortListOf,
  VoiceStep,
  type VoiceStepProps,
} from '../../../../../app/features/onboarding/voice-step.tsx';
import { ON_DEVICE_MODELS } from '../../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../../../../app/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION } from '../../../../support/app/browser-recognition.ts';
import { interact, mount, must } from '../../../../support/app/dom.ts';

interface Heard {
  readonly calls: string[];
  readonly host: StepHost;
  /** What Next would run now (the last `commit`), or `null`. */
  save(): (() => Promise<void>) | null;
}

const fakeHost = (): Heard => {
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

const settingsOf = (overrides: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...overrides });

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

/** Every catalog engine as a voice this browser can run (absent, installable), or none of them runnable. */
const voicesThatRun = (runs: boolean): OnDeviceVoices =>
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

const voiceProps = (overrides: Partial<VoiceStepProps> = {}): VoiceStepProps => ({
  settings: settingsOf(),
  update: () => undefined,
  voices: voicesThatRun(true),
  browserSupport: AVAILABLE_RECOGNITION,
  deviceClass: 'computer',
  ...overrides,
});

const engines = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>('.fy-engine-card')].map(node => node.dataset.engine ?? '');

describe('<VoiceStep>', () => {
  it('shows at once with no title or button of its own, Parakeet 110M chosen, and a short set of cards with Off', async () => {
    const { calls, host } = fakeHost();
    const view = await mount(<VoiceStep {...voiceProps({ step: host })} />);
    expect(view.container.querySelector('h2')).toBeNull();
    expect(view.container.querySelector('.fy-voice-step-line')?.textContent?.length).toBeLessThanOrEqual(160);
    expect(view.container.querySelector<HTMLElement>('[data-engine="parakeet-tdt-110m"]')?.dataset.selected).toBe(
      'true',
    );
    expect(calls).toEqual(['ready']);
    expect(engines(view.container)).toEqual([
      'parakeet-tdt-110m',
      'sherpa-zipformer-en',
      'moonshine-base-en',
      'browser',
      'off',
    ]);
    await view.unmount();
  });

  it('chooses nothing on arrival when the default engine cannot run here, so Next saves nothing', async () => {
    const { host, save } = fakeHost();
    const view = await mount(<VoiceStep {...voiceProps({ step: host, voices: voicesThatRun(false) })} />);
    expect(view.container.querySelector('.fy-engine-card[data-selected="true"]')).toBeNull();
    expect(save()).toBeNull();
    await view.unmount();
  });

  it('puts Parakeet 110M first on a phone, as it does on a computer', async () => {
    const view = await mount(<VoiceStep {...voiceProps({ deviceClass: 'phone' })} />);
    expect(engines(view.container)[0]).toBe('parakeet-tdt-110m');
    await view.unmount();
  });

  it('writes nothing when a card is chosen; Next saves the pick on this device', async () => {
    const { calls, host, save } = fakeHost();
    const patches: unknown[] = [];
    const view = await mount(<VoiceStep {...voiceProps({ step: host, update: patch => patches.push(patch) })} />);
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('[data-engine="browser"] input'), 'radio').click(),
    );
    expect(patches).toEqual([]);
    await save()?.();
    expect(patches).toEqual([{ enabled: true, engine: 'browser' }]);
    expect(calls).toEqual(['ready']);
    await view.unmount();
  });

  it('Next on the preselected default saves it; a pick equal to what is saved saves nothing', async () => {
    const first = fakeHost();
    const patches: unknown[] = [];
    const fresh = await mount(
      <VoiceStep {...voiceProps({ step: first.host, update: patch => patches.push(patch) })} />,
    );
    await first.save()?.();
    expect(patches).toEqual([{ enabled: true, engine: 'parakeet-tdt-110m' }]);
    await fresh.unmount();
    const second = fakeHost();
    const held = await mount(
      <VoiceStep {...voiceProps({ step: second.host, settings: settingsOf({ engine: 'browser' }) })} />,
    );
    expect(second.save()).toBeNull();
    await interact(() =>
      must(held.container.querySelector<HTMLInputElement>('[data-engine="off"] input'), 'radio').click(),
    );
    expect(second.save()).not.toBeNull();
    await interact(() =>
      must(held.container.querySelector<HTMLInputElement>('[data-engine="browser"] input'), 'radio').click(),
    );
    expect(second.save()).toBeNull();
    await held.unmount();
  });

  it('switches dictation off from the Off card and keeps the engine, like the Settings switch', async () => {
    const { host, save } = fakeHost();
    const patches: unknown[] = [];
    const view = await mount(<VoiceStep {...voiceProps({ step: host, update: patch => patches.push(patch) })} />);
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('[data-engine="off"] input'), 'radio').click(),
    );
    await save()?.();
    expect(patches).toEqual([{ enabled: false }]);
    await view.unmount();
  });

  it('says a refused write, so the shell keeps the page', async () => {
    const { host, save } = fakeHost();
    const view = await mount(
      <VoiceStep
        {...voiceProps({
          step: host,
          update: () => {
            throw new Error('refused');
          },
        })}
      />,
    );
    await expect(save()?.()).rejects.toThrow('refused');
    await view.unmount();
  });

  it('shows what is already chosen on this device, and Off when dictation is off', async () => {
    const view = await mount(<VoiceStep {...voiceProps({ settings: settingsOf({ engine: 'browser' }) })} />);
    expect(view.container.querySelector<HTMLElement>('[data-engine="browser"]')?.dataset.selected).toBe('true');
    await view.render(<VoiceStep {...voiceProps({ settings: settingsOf({ enabled: false, engine: 'browser' }) })} />);
    expect(view.container.querySelector<HTMLElement>('[data-engine="off"]')?.dataset.selected).toBe('true');
    expect(view.container.querySelector<HTMLElement>('[data-engine="browser"]')?.dataset.selected).toBe('false');
    await view.unmount();
  });

  it('opens the whole catalog on request, once', async () => {
    const view = await mount(<VoiceStep {...voiceProps()} />);
    const more = must(view.container.querySelector<HTMLDetailsElement>('details.fy-voice-more'), 'the disclosure');
    expect(more.querySelector('summary')?.textContent).toBe('Show every engine');
    await interact(() => {
      more.open = true;
      more.dispatchEvent(new Event('toggle'));
    });
    expect(engines(view.container)).toEqual([...ON_DEVICE_MODELS.map(model => model.id), 'browser', 'off']);
    expect(more.querySelector('summary')?.textContent).toBe('Show fewer engines');
    expect(
      [...view.container.querySelectorAll('button')].some(button => button.textContent === 'Show every engine'),
    ).toBe(false);
    await view.unmount();
  });

  it('draws with no host at all (a page rendered by itself)', async () => {
    const view = await mount(<VoiceStep {...voiceProps()} />);
    expect(view.container.querySelectorAll('.fy-engine-card').length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('keeps the pure choices pure', () => {
    expect(choiceOf(settingsOf())).toBeNull();
    expect(choiceOf(settingsOf({ engine: 'parakeet' }))).toBe('parakeet');
    expect(choiceOf(settingsOf({ enabled: false, engine: 'parakeet' }))).toBe('off');
    expect(patchFor('off')).toEqual({ enabled: false });
    expect(patchFor('browser')).toEqual({ enabled: true, engine: 'browser' });
    expect(shortListOf('phone')).toEqual(['parakeet-tdt-110m', 'sherpa-zipformer-en', 'moonshine-base-en']);
  });
});

describe('<SpeedupsStep>', () => {
  const draw = (settings: SttSettings, step?: StepHost): ReactElement => (
    <SpeedupsStep settings={settings} step={step} />
  );

  it('stays out of the way unless a local engine was picked: it skips and draws nothing', async () => {
    for (const settings of [
      settingsOf(),
      settingsOf({ engine: 'browser' }),
      settingsOf({ enabled: false, engine: 'parakeet' }),
    ]) {
      const { calls, host } = fakeHost();
      const view = await mount(draw(settings, host));
      expect(view.container.textContent).toBe('');
      expect(calls).toEqual(['skip:not-needed']);
      await view.unmount();
    }
  });

  it('shows once a local engine is picked, and says it is optional', async () => {
    const { calls, host } = fakeHost();
    const view = await mount(draw(settingsOf({ engine: 'sherpa-zipformer-en' }), host));
    expect(view.container.querySelector('h2')).toBeNull();
    expect(view.container.textContent).toContain('Optional');
    expect(calls).toEqual(['ready']);
    await view.unmount();
  });

  it('decides from the same settings the Voice step writes', () => {
    expect(needsSpeedups(settingsOf({ engine: 'parakeet' }))).toBe(true);
    expect(needsSpeedups(settingsOf({ engine: null }))).toBe(false);
  });
});
