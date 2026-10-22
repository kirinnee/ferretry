/**
 * Proves Settings › Voice › Engine: every catalog model and browser voice in one list, each saying
 * what it costs and whether words appear live; Install, Cancel, Resume and Remove on a model; "Use
 * this" through the one change port; and Try it, which records, finishes and shows the words with
 * their timings without touching which engine is in use.
 */

import { describe, expect, it } from 'bun:test';
import {
  activeEngineNote,
  EngineCatalogList,
  type EngineCatalogListProps,
  INSTALL_FOOTNOTE,
  LIVE_WORDS_BADGE,
  NEAR_LIVE_BADGE,
  ON_DEVICE_BADGE,
  type TrialClock,
} from '../../../../src/features/settings/engine-catalog-list.tsx';
import {
  BROWSER_ACTIVE_NOTE,
  BROWSER_ENGINE_DISCLOSURE,
  BROWSER_ENGINE_LABEL,
  NO_ENGINE_NOTE,
  PARAKEET_ACTIVE_NOTE,
} from '../../../../src/features/settings/voice-engine-choice.tsx';
import { type OnDeviceModel, PARAKEET_CATALOG_MODEL } from '../../../../src/lib/stt/model-catalog.ts';
import {
  ModelInstallError,
  type ModelInstaller,
  type ModelInstallOptions,
  type ModelStoreStatus,
} from '../../../../src/lib/stt/model-store.ts';
import {
  type OnDeviceSession,
  type OnDeviceSessionOptions,
  OnDeviceVoice,
} from '../../../../src/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../src/lib/stt/on-device-voices.ts';
import {
  AVAILABLE_RECOGNITION,
  fakeRecognitionProvider,
  UNSUPPORTED_RECOGNITION,
} from '../../../support/browser-recognition.ts';
import { interact, mount, must } from '../../../support/dom.ts';

const STREAMING = {
  ...PARAKEET_CATALOG_MODEL,
  id: 'zipformer-test',
  label: 'Zipformer Test',
  shortName: 'Zipformer',
  family: 'zipformer',
  licence: 'Apache-2.0',
  languages: ['en'],
  streaming: true,
  nearLive: false,
  measured: { where: 'Bun on x64', speed: '6.6 s of audio in 0.6 s', accuracy: '8% WER' },
} as unknown as OnDeviceModel;

class Store implements ModelInstaller {
  readonly totalBytes = 50_000_000;
  state: ModelStoreStatus = { state: 'absent' };
  pending: { resolve(): void; reject(error: unknown): void; options: ModelInstallOptions } | null = null;
  removes = 0;
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.state);
  }
  install(options: ModelInstallOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, options };
    });
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
  cancelled = 0;
  timings(): { readonly loadMs?: number; readonly model?: string } {
    return { loadMs: 1_800, model: 'Zipformer test · WebAssembly' };
  }
  constructor(options: OnDeviceSessionOptions) {
    this.options = options;
  }
  start(): void {
    this.options.onStart();
  }
  finish(): Promise<string> {
    return new Promise(resolve => {
      this.finished = resolve;
    });
  }
  cancel(): void {
    this.cancelled += 1;
  }
}

const voiceFor = (model: OnDeviceModel, store: Store, sessions: Session[]) =>
  new OnDeviceVoice({
    model,
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
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    fire: () => {
      for (const timer of timers.splice(0)) timer();
    },
  };
};

/** One provider for every render: React's dev diff reads a changed prop's getters, and the fake's throw. */
const SHARED_PROVIDER = fakeRecognitionProvider();

const props = (overrides: Partial<EngineCatalogListProps> = {}): EngineCatalogListProps => ({
  value: null,
  onChange: () => undefined,
  voices: null,
  browserSupport: AVAILABLE_RECOGNITION,
  browserProvider: SHARED_PROVIDER,
  ...overrides,
});

const row = (container: HTMLElement, id: string): HTMLElement =>
  must(container.querySelector<HTMLElement>(`li[data-engine="${id}"]`), `the ${id} row`);

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

describe('<EngineCatalogList>', () => {
  it('lists every model and browser voice with what each costs, live-words badges, and nothing chosen', async () => {
    const view = await mount(<EngineCatalogList {...props()} />);
    const parakeet = row(view.container, 'parakeet');
    expect(parakeet.textContent).toContain(PARAKEET_CATALOG_MODEL.label);
    expect(parakeet.textContent).toContain('NVIDIA Parakeet');
    expect(parakeet.textContent).toContain('CC-BY-4.0');
    expect(parakeet.textContent).toContain('10 languages');
    expect(parakeet.textContent).toContain(ON_DEVICE_BADGE);
    expect(parakeet.textContent).toContain(NEAR_LIVE_BADGE);
    expect(parakeet.textContent).toContain('Parakeet is not available in this copy of Ferretry.');
    const browser = row(view.container, 'browser');
    expect(browser.textContent).toContain(`${BROWSER_ENGINE_LABEL} (${BROWSER_ENGINE_DISCLOSURE})`);
    expect(browser.textContent).toContain(LIVE_WORDS_BADGE);
    expect(view.container.textContent).toContain(INSTALL_FOOTNOTE);
    expect(view.container.textContent).toContain(NO_ENGINE_NOTE);
    expect(
      [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].some(radio => radio.checked),
    ).toBe(false);
    await view.unmount();
  });

  it('records "Use this" through the one change port, and says which engine is in use', async () => {
    const chosen: string[] = [];
    const view = await mount(<EngineCatalogList {...props({ onChange: engine => chosen.push(engine) })} />);
    await interact(() =>
      must(view.container.querySelector<HTMLInputElement>('input[aria-label="Use Parakeet"]'), 'radio').click(),
    );
    await interact(() =>
      must(
        view.container.querySelector<HTMLInputElement>(`input[aria-label="Use ${BROWSER_ENGINE_LABEL}"]`),
        'radio',
      ).click(),
    );
    expect(chosen).toEqual(['parakeet', 'browser']);
    await view.render(<EngineCatalogList {...props({ value: 'parakeet' })} />);
    expect(row(view.container, 'parakeet').textContent).toContain('In use');
    expect(view.container.textContent).toContain(PARAKEET_ACTIVE_NOTE);
    await view.render(<EngineCatalogList {...props({ value: 'browser' })} />);
    expect(view.container.textContent).toContain(BROWSER_ACTIVE_NOTE);
    await view.unmount();
  });

  it('installs a model from its own button with progress and Cancel, then offers Try it and Remove', async () => {
    const store = new Store();
    const sessions: Session[] = [];
    const voice = voiceFor(STREAMING, store, sessions);
    const shown = await mount(
      <EngineCatalogList {...props({ models: [STREAMING], voices: new OnDeviceVoices([voice]) })} />,
    );
    await settle();
    const model = row(shown.container, 'zipformer-test');
    expect(model.textContent).toContain('k2 Zipformer · 683 MB · Apache-2.0 · English');
    expect(model.textContent).toContain(LIVE_WORDS_BADGE);
    expect(model.textContent).not.toContain(NEAR_LIVE_BADGE);
    expect(model.textContent).toContain('Install Zipformer (50 MB)');
    await interact(() => button(model, 'Install Zipformer').click());
    await interact(() =>
      store.pending?.options.onProgress?.({ label: 'Encoder', downloadedBytes: 25_000_000, totalBytes: 50_000_000 }),
    );
    expect(model.textContent).toContain('Downloading encoder…');
    expect(model.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    await interact(() => button(model, 'Cancel').click());
    store.state = {
      state: 'installed',
      version: 'Zipformer v1',
      bytes: 50_000_000,
      installedAt: '2026-10-22T00:00:00.000Z',
    };
    await interact(async () => {
      store.pending?.resolve();
      await Promise.resolve();
    });
    await settle();
    expect(model.textContent).toContain('Installed · 50 MB');
    expect(model.textContent).toContain('Zipformer v1');
    expect(model.textContent).toContain('Try it (5 s)');
    await interact(() => button(model, 'Remove Zipformer').click());
    await interact(() => button(model, 'Keep it').click());
    expect(store.removes).toBe(0);
    await interact(() => button(model, 'Remove Zipformer').click());
    await interact(() => button(model, 'Remove').click());
    await settle();
    expect(store.removes).toBe(1);
    expect(model.textContent).toContain('Install Zipformer');
    await shown.unmount();
  });

  it('shows a failed install, a partial download to resume or discard, and a model that cannot run', async () => {
    const store = new Store();
    store.state = { state: 'partial', downloadedBytes: 20_000_000 };
    const voice = voiceFor(STREAMING, store, []);
    const view = await mount(
      <EngineCatalogList {...props({ models: [STREAMING], voices: new OnDeviceVoices([voice]) })} />,
    );
    await settle();
    const model = row(view.container, 'zipformer-test');
    expect(model.textContent).toContain('20 MB of 50 MB downloaded');
    await interact(() => button(model, 'Resume (30 MB left)').click());
    await interact(async () => {
      store.pending?.reject(new ModelInstallError('network', 'The encoder stopped downloading.'));
      await Promise.resolve();
    });
    await settle();
    expect(model.querySelector('[role="alert"]')?.textContent).toBe('The encoder stopped downloading.');
    await interact(() => button(model, 'Discard partial download').click());
    await settle();
    expect(store.removes).toBe(1);
    await view.unmount();

    const unsupported = new OnDeviceVoice({
      model: STREAMING,
      support: { available: false, reason: 'This browser cannot run WebAssembly in a worker.' },
      store: null,
      openSession: null,
    });
    const refused = await mount(<EngineCatalogList {...props({ parakeet: unsupported })} />);
    expect(row(refused.container, 'parakeet').textContent).toContain(
      'This browser cannot run WebAssembly in a worker.',
    );
    await refused.unmount();
  });

  it('tries an installed model: records, shows live words, then the text and how long each part took', async () => {
    const store = new Store();
    store.state = { state: 'installed', version: 'Zipformer v1', bytes: 50_000_000, installedAt: 'not a date' };
    const sessions: Session[] = [];
    const voice = voiceFor(STREAMING, store, sessions);
    const time = manualClock();
    const chosen: string[] = [];
    const view = await mount(
      <EngineCatalogList
        {...props({
          models: [STREAMING],
          voices: new OnDeviceVoices([voice]),
          clock: time.clock,
          onChange: engine => chosen.push(engine),
        })}
      />,
    );
    await settle();
    const model = row(view.container, 'zipformer-test');
    expect(model.textContent).toContain('not a date');
    expect(model.textContent).toContain('Measured (Bun on x64): 6.6 s of audio in 0.6 s; 8% WER');
    await interact(() => button(model, 'Try it').click());
    expect(model.querySelector('[data-trial="running"]')?.textContent).toContain('Recording 5 s');
    time.advance(700);
    await interact(() => sessions[0]?.options.onLive?.({ committed: 'hello', interim: 'world', paused: false }));
    expect(model.textContent).toContain('hello world');
    time.advance(4_300);
    await interact(() => time.fire());
    expect(model.textContent).toContain('Transcribing…');
    time.advance(400);
    await interact(async () => {
      sessions[0]?.finished?.('hello world');
      await Promise.resolve();
    });
    await settle();
    const result = must(model.querySelector<HTMLElement>('[data-trial="done"]'), 'the trial result');
    expect(result.textContent).toContain('“hello world”');
    expect(result.textContent).toContain('0.7 s in');
    expect(result.textContent).toContain('0.4 s');
    expect(result.textContent).toContain('Model load (first take only)1.8 s');
    expect(result.textContent).toContain('Ran onZipformer test · WebAssembly');
    expect(chosen).toEqual([]);

    await interact(() => button(model, 'Try again').click());
    await interact(() => button(model, 'Stop trial').click());
    expect(sessions[1]?.cancelled).toBe(1);
    expect(model.querySelector('[data-trial]')).toBeNull();
    await view.unmount();
  });

  it('says when a trial heard nothing early or failed, and cancels a trial left running on unmount', async () => {
    const store = new Store();
    store.state = { state: 'installed', version: 'v', bytes: 1, installedAt: '2026-10-22T00:00:00.000Z' };
    const sessions: Session[] = [];
    const voice = voiceFor(STREAMING, store, sessions);
    const time = manualClock();
    const view = await mount(
      <EngineCatalogList {...props({ models: [STREAMING], voices: new OnDeviceVoices([voice]), clock: time.clock })} />,
    );
    await settle();
    const model = row(view.container, 'zipformer-test');
    await interact(() => button(model, 'Try it').click());
    await interact(() => time.fire());
    await interact(async () => {
      sessions[0]?.finished?.('');
      await Promise.resolve();
    });
    await settle();
    expect(model.textContent).toContain('(nothing heard)');
    expect(model.textContent).toContain('after Stop');

    await interact(() => button(model, 'Try again').click());
    await interact(() =>
      sessions[1]?.options.onFailure(
        Object.assign(new Error('The microphone is blocked.'), { code: 'permission-denied' }) as never,
      ),
    );
    await settle();
    expect(model.querySelector('[role="alert"]')?.textContent).toBe('The microphone is blocked.');

    await interact(() => button(model, 'Try again').click());
    await view.unmount();
    expect(sessions[2]?.cancelled).toBe(1);
  });

  it('tries browser voice through its own recognition, and explains when it cannot run here', async () => {
    const provider = fakeRecognitionProvider();
    const time = manualClock();
    const view = await mount(<EngineCatalogList {...props({ browserProvider: provider, clock: time.clock })} />);
    const browser = row(view.container, 'browser');
    await interact(() => button(browser, 'Try it').click());
    await interact(() => provider.begin());
    expect(browser.textContent).toContain('Recording 5 s');
    await view.unmount();

    const unsupported = await mount(<EngineCatalogList {...props({ browserSupport: UNSUPPORTED_RECOGNITION })} />);
    expect(row(unsupported.container, 'browser').textContent).toContain('does not support dictation for web apps');
    await unsupported.unmount();
  });
});

describe('activeEngineNote', () => {
  it('promises the audio stays here only for an on-device engine', () => {
    expect(activeEngineNote(null)).toBe(NO_ENGINE_NOTE);
    expect(activeEngineNote('browser')).toBe(BROWSER_ACTIVE_NOTE);
    expect(activeEngineNote('parakeet')).toBe(PARAKEET_ACTIVE_NOTE);
    expect(activeEngineNote('unknown' as never)).toBe('This engine is active: audio never leaves this device.');
  });
});
