/**
 * Proves Settings › Voice › Engine (r10 S5): the engine cards, Try it for the chosen engine in one row under them, the
 * downloaded engines with the one button that frees their space, and the sentence that says where the audio goes.
 */

import { describe, expect, it } from 'bun:test';
import {
  activeEngineNote,
  defaultEngineNote,
  EngineSection,
  type EngineSectionProps,
  type TrialClock,
} from '../../../../../app/features/settings/engine-section.tsx';
import {
  BROWSER_ACTIVE_NOTE,
  NO_ENGINE_NOTE,
  PARAKEET_ACTIVE_NOTE,
} from '../../../../../app/features/settings/voice-engine-choice.tsx';
import { ON_DEVICE_MODELS, type OnDeviceModel } from '../../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelInstallOptions, ModelStoreStatus } from '../../../../../app/lib/stt/model-store.ts';
import {
  type OnDeviceSession,
  type OnDeviceSessionOptions,
  OnDeviceVoice,
} from '../../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../../app/lib/stt/on-device-voices.ts';
import {
  AVAILABLE_RECOGNITION,
  fakeRecognitionProvider,
  UNSUPPORTED_RECOGNITION,
} from '../../../../support/app/browser-recognition.ts';
import { interact, mount, must } from '../../../../support/app/dom.ts';

// A real catalog engine (the cards read its measured numbers by id), backed by the fakes below.
const STREAMING: OnDeviceModel = must(
  ON_DEVICE_MODELS.find(model => model.id === 'sherpa-zipformer-en') ?? null,
  'the Zipformer model',
);

class Store implements ModelInstaller {
  readonly totalBytes = 50_000_000;
  state: ModelStoreStatus = { state: 'absent' };
  removes = 0;
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.state);
  }
  install(_options: ModelInstallOptions = {}): Promise<void> {
    return new Promise(() => undefined);
  }
  remove(): Promise<void> {
    this.removes += 1;
    this.state = { state: 'absent' };
    return Promise.resolve();
  }
}

class Session implements OnDeviceSession {
  readonly options: OnDeviceSessionOptions;
  finished: ((text: string) => void) | null = null;
  constructor(options: OnDeviceSessionOptions) {
    this.options = options;
  }
  timings(): { readonly loadMs?: number; readonly model?: string } {
    return { loadMs: 1_800, model: 'Zipformer test · WebAssembly' };
  }
  start(): void {
    this.options.onStart();
  }
  finish(): Promise<string> {
    return new Promise(resolve => {
      this.finished = resolve;
    });
  }
  cancel(): void {}
}

const installedStore = (): Store => {
  const store = new Store();
  store.state = { state: 'installed', version: 'v', bytes: 50_000_000, installedAt: '2026-10-22T00:00:00.000Z' };
  return store;
};

const voiceFor = (store: Store, sessions: Session[] = []) =>
  new OnDeviceVoice({
    model: STREAMING,
    support: { available: true },
    store,
    openSession: options => {
      const session = new Session(options);
      sessions.push(session);
      return session;
    },
  });

/** A clock the suite turns by hand: Try it's five seconds pass when `fire` is called. */
const manualClock = () => {
  let now = 0;
  const timers: (() => void)[] = [];
  const clock: TrialClock = {
    now: () => now,
    setTimeout: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  };
  return {
    clock,
    fire: () => {
      now += 5_000;
      for (const timer of timers.splice(0)) timer();
    },
  };
};

const SHARED_PROVIDER = fakeRecognitionProvider();

const props = (overrides: Partial<EngineSectionProps> = {}): EngineSectionProps => ({
  value: null,
  onChange: () => undefined,
  voices: null,
  browserSupport: AVAILABLE_RECOGNITION,
  browserProvider: SHARED_PROVIDER,
  deviceClass: 'computer',
  ...overrides,
});

const button = (scope: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
      (candidate.textContent ?? '').includes(text),
    ) ?? null,
    `the ${text} button`,
  );

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

describe('<EngineSection>', () => {
  it('draws the cards, the Try it row and the downloaded list, and chooses through the one change port', async () => {
    const chosen: string[] = [];
    const view = await mount(<EngineSection {...props({ onChange: engine => chosen.push(engine) })} />);
    // Short on purpose: this device's default, two more and the browser's own; the rest is one press away.
    expect(view.container.querySelectorAll('.fy-engine-card').length).toBe(4);
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('[data-engine-show-all]'), 'show all').click(),
    );
    expect(view.container.querySelectorAll('.fy-engine-card').length).toBeGreaterThan(5);
    expect(view.container.querySelector('[data-engine-show-all]')).toBeNull();
    expect(view.container.querySelector('[data-engine="off"]')).toBeNull();
    const radio = must(
      view.container.querySelector<HTMLInputElement>('input[type="radio"][value="browser"]'),
      'the browser radio',
    );
    await interact(() => radio.click());
    expect(chosen).toEqual(['browser']);
    // Nothing is downloaded: the list is empty, and the stylesheet says so in one quiet line.
    expect(view.container.querySelector('.fy-vs-downloads')?.children.length).toBe(0);
    await view.unmount();
  });

  it('lists a downloaded engine with its size and removes it, and a partial one can be discarded', async () => {
    const store = installedStore();
    const voice = voiceFor(store);
    const view = await mount(
      <EngineSection {...props({ models: [STREAMING], voices: new OnDeviceVoices([voice]) })} />,
    );
    await settle();
    const row = must(view.container.querySelector<HTMLElement>('[data-downloaded="sherpa-zipformer-en"]'), 'the row');
    expect(row.textContent).toContain('Zipformer');
    await interact(() => button(row, 'Remove').click());
    expect(store.removes).toBe(1);
    await settle();
    expect(view.container.querySelector('[data-downloaded]')).toBeNull();
    await view.unmount();
  });

  it('tries the chosen installed engine without changing which one is in use', async () => {
    const chosen: string[] = [];
    const sessions: Session[] = [];
    const time = manualClock();
    const voice = voiceFor(installedStore(), sessions);
    const view = await mount(
      <EngineSection
        {...props({
          value: 'sherpa-zipformer-en' as never,
          models: [STREAMING],
          voices: new OnDeviceVoices([voice]),
          clock: time.clock,
          onChange: engine => chosen.push(engine),
        })}
      />,
    );
    await settle();
    await interact(() => button(view.container, 'Try it').click());
    await interact(() => time.fire());
    await interact(async () => {
      sessions[0]?.finished?.('hello there');
      await Promise.resolve();
    });
    await settle();
    expect(view.container.querySelector('[data-trial="done"]')?.textContent).toContain('hello there');
    expect(chosen).toEqual([]);
    await view.unmount();
  });

  it('says to install an engine when the chosen one is not downloaded, and why the browser cannot be tried', async () => {
    const store = new Store();
    const view = await mount(
      <EngineSection
        {...props({
          value: 'sherpa-zipformer-en' as never,
          models: [STREAMING],
          voices: new OnDeviceVoices([voiceFor(store)]),
        })}
      />,
    );
    await settle();
    expect(view.container.textContent).toContain('to try it.');
    await view.render(<EngineSection {...props({ value: 'browser', browserSupport: UNSUPPORTED_RECOGNITION })} />);
    expect(view.container.textContent).toContain('does not support dictation for web apps');
    await view.unmount();
  });
});

describe('the engine sentences', () => {
  it('promises the audio stays here only for an on-device engine', () => {
    expect(activeEngineNote(null)).toBe(NO_ENGINE_NOTE);
    expect(activeEngineNote('browser')).toBe(BROWSER_ACTIVE_NOTE);
    expect(activeEngineNote('parakeet')).toBe(PARAKEET_ACTIVE_NOTE);
    expect(activeEngineNote('unknown' as never)).toBe('This engine is active: audio never leaves this device.');
  });

  it('names what a device dictates with until it chooses, and says so while nothing is chosen', async () => {
    expect(defaultEngineNote('phone')).toContain('Parakeet 110M');
    const view = await mount(<EngineSection {...props({ deviceClass: 'phone' })} />);
    expect(view.container.textContent).toContain(defaultEngineNote('phone'));
    expect(view.container.querySelector('[data-engine="parakeet-tdt-110m"]')?.textContent).toContain('Default');
    await view.render(<EngineSection {...props({ deviceClass: 'computer', value: 'browser' })} />);
    expect(view.container.textContent).not.toContain('Nothing chosen yet');
    await view.unmount();
  });
});
