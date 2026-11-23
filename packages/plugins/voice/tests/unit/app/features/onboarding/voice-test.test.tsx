/**
 * "Test your audio" on the Voice step: the permission is asked by a button (never on arrival), a recorded line comes back as
 * the picked engine's words, a sample is read aloud with the Read-aloud voice, and every way a test cannot run says why in a
 * sentence and offers no dead control. The microphone, the engine and the speaker are fakes; no model, no audio.
 */

import { describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import {
  MIC_DENIED_MESSAGE,
  type MicPort,
  type MicState,
} from '../../../../../app/features/onboarding/mic-permission.ts';
import { SAMPLE_LINE, testEngineOf, VoiceTest } from '../../../../../app/features/onboarding/voice-test.tsx';
import { ReadAloudProvider } from '../../../../../app/hooks/use-read-aloud.ts';
import { BrowserRecognitionError } from '../../../../../app/lib/stt/browser-recognition.ts';
import { ON_DEVICE_MODELS } from '../../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelStoreStatus } from '../../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice, type OnDeviceSession } from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import type { SpeakerPort } from '../../../../../app/lib/voice-chat/ports.ts';
import { createReadAloud } from '../../../../../app/lib/voice-chat/read-aloud.ts';
import { interact, mount, must } from '../../../../support/app/dom.ts';
import { settleUntil } from '../../../../support/app/settle.ts';

const MODEL = must(
  ON_DEVICE_MODELS.find(model => model.id === 'sherpa-zipformer-en'),
  'the Sherpa model',
);

class Store implements ModelInstaller {
  readonly totalBytes = 86_000_000;
  readonly #status: ModelStoreStatus;
  constructor(status: ModelStoreStatus) {
    this.#status = status;
  }
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.#status);
  }
  install(): Promise<void> {
    return new Promise(() => undefined);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const INSTALLED: ModelStoreStatus = {
  state: 'installed',
  version: 'v',
  bytes: 86_000_000,
  installedAt: '2026-11-23T00:00:00Z',
};

/** A voice whose sessions return `said` (or reject) after the take; `opened` counts them. */
const voiceOf = (
  status: ModelStoreStatus,
  said: string | Error,
  opened: { count: number } = { count: 0 },
): OnDeviceVoice =>
  new OnDeviceVoice({
    model: MODEL,
    support: { available: true },
    store: new Store(status),
    openSession: options => {
      opened.count += 1;
      const session: OnDeviceSession = {
        start: () => void setTimeout(() => options.onStart(), 0),
        finish: () => (said instanceof Error ? Promise.reject(said) : Promise.resolve(said)),
        cancel: () => undefined,
      };
      return session;
    },
  });

const voicesOf = async (voice: OnDeviceVoice): Promise<OnDeviceVoices> => {
  const all = new OnDeviceVoices([voice]);
  await all.refresh();
  return all;
};

const micOf = (state: MicState, after: MicState = { kind: 'granted' }): MicPort & { requests: number } => {
  const port = {
    requests: 0,
    state: () => Promise.resolve(state),
    request: () => {
      port.requests += 1;
      return Promise.resolve(after);
    },
  };
  return port;
};

const FAST = {
  now: () => Date.now(),
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  recordMs: 20,
};

const speakerOf = (supported = true) => {
  const said: string[] = [];
  const speaker: SpeakerPort = {
    supported,
    voices: () => [{ id: 'v', name: 'V', lang: 'en-US', local: true, isDefault: true }],
    unlock: () => undefined,
    speak: (request, onEvent) => {
      said.push(...request.segments);
      onEvent({ type: 'segment', index: 0 });
    },
    stop: () => undefined,
  };
  return { said, controller: createReadAloud({ speaker, language: () => 'en-US' }) };
};

const withSpeech = (controller: ReturnType<typeof speakerOf>['controller'], child: ReactElement): ReactElement => (
  <ReadAloudProvider controller={controller}>{child}</ReadAloudProvider>
);

const action = (root: HTMLElement, id: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`[data-test-action="${id}"]`);

describe('<VoiceTest> permission', () => {
  it('does not ask on arrival; Allow asks once, and Record unlocks', async () => {
    const mic = micOf({ kind: 'prompt' });
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller } = speakerOf();
    const view = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={mic} />),
    );
    await settleUntil(() => action(view.container, 'allow') !== null, 'the Allow button', interact);
    expect(mic.requests).toBe(0);
    expect(action(view.container, 'record')?.disabled).toBe(true);
    await interact(() => action(view.container, 'allow')?.click());
    await settleUntil(() => action(view.container, 'record')?.disabled === false, 'Record to unlock', interact);
    expect(mic.requests).toBe(1);
    expect(view.container.querySelector('[data-mic="granted"]')).not.toBeNull();
    await view.unmount();
  });

  it('says what to do when the browser blocks the microphone, and offers Try again', async () => {
    const mic = micOf({ kind: 'denied', message: MIC_DENIED_MESSAGE }, { kind: 'denied', message: MIC_DENIED_MESSAGE });
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller } = speakerOf();
    const view = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={mic} />),
    );
    await settleUntil(() => view.container.querySelector('[data-mic="denied"]') !== null, 'the denied line', interact);
    expect(view.container.textContent).toContain('lock icon');
    expect(action(view.container, 'allow')?.textContent).toContain('Try again');
    expect(action(view.container, 'record')?.disabled).toBe(true);
    await view.unmount();
  });

  it('says why when there is no microphone at all, with nothing to press but Try again', async () => {
    const mic = micOf({ kind: 'unavailable', message: 'No microphone was found.', retry: true });
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller } = speakerOf();
    const view = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={mic} />),
    );
    await settleUntil(
      () => view.container.querySelector('[data-mic="unavailable"]') !== null,
      'the unavailable line',
      interact,
    );
    expect(view.container.textContent).toContain('No microphone was found.');
    expect(action(view.container, 'record')?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('<VoiceTest> record a line', () => {
  it('shows what the picked engine heard', async () => {
    const opened = { count: 0 };
    const voices = await voicesOf(voiceOf(INSTALLED, 'Move the deploy to Friday.', opened));
    const { controller } = speakerOf();
    const view = await mount(
      withSpeech(
        controller,
        <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={micOf({ kind: 'granted' })} clock={FAST} />,
      ),
    );
    await settleUntil(() => action(view.container, 'record')?.disabled === false, 'Record to unlock', interact);
    await interact(() => action(view.container, 'record')?.click());
    await settleUntil(() => view.container.querySelector('[data-test-said]') !== null, 'the transcript', interact);
    expect(view.container.querySelector('[data-test-said]')?.textContent).toContain('Move the deploy to Friday.');
    expect(opened.count).toBe(1);
    expect(action(view.container, 'record')?.textContent).toContain('Record again');
    await view.unmount();
  });

  it('says so when nothing was heard, and when the engine fails', async () => {
    const silent = await voicesOf(voiceOf(INSTALLED, ''));
    const { controller } = speakerOf();
    const quiet = await mount(
      withSpeech(
        controller,
        <VoiceTest pick="sherpa-zipformer-en" voices={silent} mic={micOf({ kind: 'granted' })} clock={FAST} />,
      ),
    );
    await settleUntil(() => action(quiet.container, 'record')?.disabled === false, 'Record to unlock', interact);
    await interact(() => action(quiet.container, 'record')?.click());
    await settleUntil(
      () => quiet.container.querySelector('[role="alert"]') !== null,
      'the nothing-heard note',
      interact,
    );
    expect(quiet.container.querySelector('[role="alert"]')?.textContent).toContain('Nothing was heard');
    await quiet.unmount();

    const broken = await voicesOf(
      voiceOf(INSTALLED, new BrowserRecognitionError('no-microphone', 'Another app has the microphone.')),
    );
    const failed = await mount(
      withSpeech(
        controller,
        <VoiceTest pick="sherpa-zipformer-en" voices={broken} mic={micOf({ kind: 'granted' })} clock={FAST} />,
      ),
    );
    await settleUntil(() => action(failed.container, 'record')?.disabled === false, 'Record to unlock', interact);
    await interact(() => action(failed.container, 'record')?.click());
    await settleUntil(() => failed.container.querySelector('[role="alert"]') !== null, 'the failure', interact);
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toContain('Another app has the microphone.');
    await failed.unmount();
  });

  it('offers no recording for a pick that cannot run, and says what to do', async () => {
    const voices = await voicesOf(voiceOf({ state: 'absent' }, 'hi'));
    const { controller } = speakerOf();
    const absent = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={micOf({ kind: 'granted' })} />),
    );
    await settleUntil(
      () => absent.container.textContent?.includes('Install Sherpa') === true,
      'the install note',
      interact,
    );
    expect(action(absent.container, 'record')?.disabled).toBe(true);
    await absent.unmount();

    const off = await mount(
      withSpeech(controller, <VoiceTest pick="off" voices={voices} mic={micOf({ kind: 'granted' })} />),
    );
    expect(off.container.textContent).toContain('Dictation is off');
    expect(action(off.container, 'record')?.disabled).toBe(true);
    await off.unmount();
  });
});

describe('<VoiceTest> hear a sample', () => {
  it('reads the sample line with the Read-aloud voice, and offers Stop while it reads', async () => {
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller, said } = speakerOf();
    const view = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={micOf({ kind: 'granted' })} />),
    );
    await interact(() => action(view.container, 'play')?.click());
    expect(said).toEqual([SAMPLE_LINE]);
    await settleUntil(() => action(view.container, 'stop-sample') !== null, 'Stop while reading', interact);
    await view.unmount();
  });

  it('says so, with a disabled button, where the device has no voice at all', async () => {
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller } = speakerOf(false);
    const view = await mount(
      withSpeech(controller, <VoiceTest pick="sherpa-zipformer-en" voices={voices} mic={micOf({ kind: 'granted' })} />),
    );
    expect(view.container.textContent).toContain('no voice to read aloud');
    expect(action(view.container, 'play')?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('testEngineOf', () => {
  it('blocks Off, no pick and an unavailable browser voice with a sentence, and opens nothing for them', () => {
    expect('blocked' in testEngineOf('off', null, null)).toBe(true);
    expect('blocked' in testEngineOf(null, null, null)).toBe(true);
    expect('blocked' in testEngineOf('browser', null, null)).toBe(true);
  });
});

describe('<VoiceTest> the browser’s own voice', () => {
  /** A browser voice that counts every recognition it is asked to start: the browser sends that audio to its maker. */
  const watchedBrowser = () => {
    const started = { create: 0 };
    const provider = {
      support: { available: true, availability: 'available', implementation: 'standard' },
      create: () => {
        started.create += 1;
        throw new Error('recognition must never start in the onboarding test');
      },
      watchHidden: () => () => undefined,
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    return { started, provider };
  };

  it('never starts recognition: Record is off and the page says to pick an on-device voice', async () => {
    const { started, provider } = watchedBrowser();
    const voices = await voicesOf(voiceOf(INSTALLED, 'hi'));
    const { controller } = speakerOf();
    // Even handed a perfectly available browser voice, the test must not use it.
    const props = { browserProvider: provider };
    const view = await mount(
      withSpeech(
        controller,
        <VoiceTest pick="browser" voices={voices} mic={micOf({ kind: 'granted' })} clock={FAST} {...props} />,
      ),
    );
    await settleUntil(() => view.container.querySelector('[data-mic="granted"]') !== null, 'the mic state', interact);
    expect(action(view.container, 'record')?.disabled).toBe(true);
    await interact(() => action(view.container, 'record')?.click());
    expect(started.create).toBe(0);
    expect(view.container.textContent).toContain('pick an on-device voice to test the mic here');
    await view.unmount();
  });

  it('testEngineOf says why the browser voice is not tested, and opens nothing', () => {
    const engine = testEngineOf('browser', null, null);
    expect('blocked' in engine && engine.blocked).toContain('on-device voice');
    expect('open' in engine).toBe(false);
  });
});
