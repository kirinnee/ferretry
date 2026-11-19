/**
 * The two first-run client steps, against a fake `StepHost` that records what the shell would hear:
 * `ready` once the page can draw, `skip` when it has nothing to say, `done` when the person answers, `busy` while a
 * download runs.
 */

import { describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import {
  SpeedupsStep,
  SPEEDUPS_STEP_TITLE,
  needsSpeedups,
} from '../../../../../app/features/onboarding/speedups-step.tsx';
import type { StepHost } from '../../../../../app/features/onboarding/step-host.ts';
import {
  choiceOf,
  patchFor,
  shortListOf,
  VOICE_STEP_TITLE,
  VoiceStep,
  type VoiceStepProps,
} from '../../../../../app/features/onboarding/voice-step.tsx';
import { ON_DEVICE_MODELS } from '../../../../../app/lib/stt/model-catalog.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../../../../app/lib/stt/stt-settings.ts';
import { AVAILABLE_RECOGNITION } from '../../../../support/app/browser-recognition.ts';
import { interact, mount, must } from '../../../../support/app/dom.ts';

interface Heard {
  readonly calls: string[];
  readonly host: StepHost;
}

const fakeHost = (): Heard => {
  const calls: string[] = [];
  const host: StepHost = {
    phase: 'client',
    ready: () => void calls.push('ready'),
    skip: why => void calls.push(`skip:${why}`),
    done: () => void calls.push('done'),
    busy: label => void calls.push(`busy:${label}`),
    next: () => void calls.push('next'),
    back: () => void calls.push('back'),
  };
  return { calls, host };
};

const settingsOf = (overrides: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...overrides });

const voiceProps = (overrides: Partial<VoiceStepProps> = {}): VoiceStepProps => ({
  settings: settingsOf(),
  update: () => undefined,
  voices: null,
  browserSupport: AVAILABLE_RECOGNITION,
  deviceClass: 'computer',
  ...overrides,
});

const engines = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>('.fy-engine-card')].map(node => node.dataset.engine ?? '');

describe('<VoiceStep>', () => {
  it('asks the owner’s question, shows at once, and lists a short set of cards with Off as one of them', async () => {
    const { calls, host } = fakeHost();
    const view = await mount(<VoiceStep {...voiceProps({ step: host })} />);
    expect(view.container.querySelector('h2')?.textContent).toBe(VOICE_STEP_TITLE);
    expect(calls).toEqual(['ready']);
    expect(engines(view.container)).toEqual(['parakeet', 'sherpa-zipformer-en', 'moonshine-base-en', 'browser', 'off']);
    await view.unmount();
  });

  it('puts the phone’s own default first on a phone', async () => {
    const view = await mount(<VoiceStep {...voiceProps({ deviceClass: 'phone' })} />);
    expect(engines(view.container)[0]).toBe('parakeet-tdt-110m');
    await view.unmount();
  });

  it('saves an engine on this device and answers the step when a card is chosen', async () => {
    const { calls, host } = fakeHost();
    const patches: unknown[] = [];
    const view = await mount(<VoiceStep {...voiceProps({ step: host, update: patch => patches.push(patch) })} />);
    await interact(() =>
      must(
        view.container.querySelector<HTMLInputElement>('[data-engine="sherpa-zipformer-en"] input'),
        'radio',
      ).click(),
    );
    expect(patches).toEqual([{ enabled: true, engine: 'sherpa-zipformer-en' }]);
    expect(calls).toEqual(['ready', 'done']);
    await view.unmount();
  });

  it('switches dictation off from the Off card and keeps the engine, like the Settings switch', async () => {
    const patches: unknown[] = [];
    const view = await mount(<VoiceStep {...voiceProps({ update: patch => patches.push(patch) })} />);
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('[data-engine="off"] input'), 'radio').click(),
    );
    expect(patches).toEqual([{ enabled: false }]);
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
    const more = must(
      [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
        button => button.textContent === 'Show every engine',
      ) ?? null,
      'the button',
    );
    await interact(() => more.click());
    expect(engines(view.container)).toEqual([...ON_DEVICE_MODELS.map(model => model.id), 'browser', 'off']);
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
    expect(view.container.querySelector('h2')?.textContent).toBe(SPEEDUPS_STEP_TITLE);
    expect(view.container.textContent).toContain('Optional');
    expect(calls).toEqual(['ready']);
    await view.unmount();
  });

  it('decides from the same settings the Voice step writes', () => {
    expect(needsSpeedups(settingsOf({ engine: 'parakeet' }))).toBe(true);
    expect(needsSpeedups(settingsOf({ engine: null }))).toBe(false);
  });
});
