/**
 * Voice mode's set-up in the first-run Voice step: it is the same panel Settings › Voice draws (one implementation), with
 * Talk to test held to 10 s, and it is OPTIONAL: it writes nothing to this device and never changes what Next saves.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { TALK_TEST_MS, VoiceModeSetup } from '../../../../../app/features/onboarding/voice-mode-setup.tsx';
import { VoiceStep } from '../../../../../app/features/onboarding/voice-step.tsx';
import { daemonConnection } from '../../../../../app/shell-voice.ts';
import { ON_DEVICE_MODELS } from '../../../../../app/lib/stt/model-catalog.ts';
import { OnDeviceVoice } from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import { DEFAULT_STT_SETTINGS } from '../../../../../app/lib/stt/stt-settings.ts';
import type { StepHost } from '@ferretry/kernel/contract';
import { AVAILABLE_RECOGNITION } from '../../../../support/app/browser-recognition.ts';
import { interact, type Mounted, mount } from '../../../../support/app/dom.ts';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });
const settle = (): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, 30)));

/** A machine whose speech engine and reply voice are in the given states; calls are recorded. */
const machine = (engine: 'not_installed' | 'ready', reply: 'not_installed' | 'ready' = 'not_installed') => {
  const calls: string[] = [];
  const view = (state: string, label: string, size: number) => ({
    state,
    machine: 'Studio Mac',
    label,
    sizeBytes: size,
    doneBytes: state === 'ready' ? size : 0,
    loaded: false,
  });
  return {
    calls,
    createClient: async () =>
      ({
        request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
          calls.push(`${init?.method ?? 'GET'} ${path}`);
          return schema.parse(
            path.startsWith('/v1/voice/reply-voice')
              ? view(reply, 'Kokoro 82M', 164_022_376)
              : view(engine, 'Parakeet TDT 0.6B v3', 698_905_830),
          );
        },
      }) as never,
  };
};

describe('<VoiceModeSetup>', () => {
  it('holds the first-run test to 10 seconds', () => {
    expect(TALK_TEST_MS).toBe(10_000);
  });

  it('says it is optional and offers the install, the reply voice and no test until speech is there', async () => {
    const fake = machine('not_installed');
    mounted = await mount(<VoiceModeSetup connection={daemon} createClient={fake.createClient} />);
    await settle();
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('Optional');
    expect(text).toContain('Finish later in Settings › Voice');
    expect(text).toContain('Install on Studio Mac (699 MB)');
    expect(text).toContain('Install on Studio Mac (164 MB)');
    expect(mounted.container.querySelector('[data-voice-talk-start]')).toBeNull();
    // Reading is all a first look does: no install call until a button is pressed.
    expect(fake.calls.every(call => call.startsWith('GET '))).toBe(true);
  });

  it('once speech is ready the Talk to test is there and says it listens for up to 10 s', async () => {
    const fake = machine('ready', 'ready');
    mounted = await mount(<VoiceModeSetup connection={daemon} createClient={fake.createClient} />);
    await settle();
    expect(mounted.container.querySelector('[data-voice-talk-to-test]')?.textContent).toContain('up to 10 s');
    expect(mounted.container.textContent).not.toContain('Install on Studio Mac');
  });
});

describe('<VoiceStep voiceMode>', () => {
  const host = () => {
    const calls: string[] = [];
    let saving: (() => Promise<void>) | null = null;
    const step: StepHost = {
      phase: 'client',
      appliesTo: [],
      segment: {},
      remember: () => undefined,
      ready: () => void calls.push('ready'),
      skip: why => void calls.push(`skip:${why}`),
      notNeeded: () => undefined,
      commit: next => {
        saving = next;
      },
      done: () => void calls.push('done'),
      busy: label => void calls.push(`busy:${label}`),
      next: () => undefined,
      back: () => undefined,
    };
    return { calls, step, save: () => saving };
  };
  const voices = () =>
    new OnDeviceVoices(
      ON_DEVICE_MODELS.map(
        model =>
          new OnDeviceVoice({
            model,
            support: { available: true },
            store: {
              totalBytes: 1,
              status: async () => ({ state: 'absent' as const }),
              install: () => new Promise(() => undefined),
              remove: async () => undefined,
            },
            openSession: () => {
              throw new Error('no microphone in this suite');
            },
          }),
      ),
    );

  it('draws the slot under the audio test and leaves what Next saves and the step host exactly as without it', async () => {
    const fake = machine('not_installed');
    const bare = host();
    const withSlot = host();
    const props = {
      settings: DEFAULT_STT_SETTINGS,
      update: () => undefined,
      voices: voices(),
      browserSupport: AVAILABLE_RECOGNITION,
      deviceClass: 'computer',
    } as const;
    const first = await mount(<VoiceStep {...props} step={bare.step} />);
    await first.unmount();
    mounted = await mount(
      <VoiceStep
        {...props}
        step={withSlot.step}
        voiceMode={<VoiceModeSetup connection={daemon} createClient={fake.createClient} />}
      />,
    );
    await settle();
    expect(mounted.container.querySelector('[data-voice-mode-setup]')).not.toBeNull();
    expect(withSlot.calls).toEqual(bare.calls);
    expect(withSlot.save() === null).toBe(bare.save() === null);
  });
});
