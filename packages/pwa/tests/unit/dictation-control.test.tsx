import { describe, expect, it } from 'bun:test';
import {
  DictationControl,
  type DictationControlProps,
  dictationStatusCopy,
  dictationTriggerStartsFresh,
} from '../../src/components/dictation-control.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { CaptureGraph, CaptureHost, MicrophoneStream } from '../../src/lib/stt/audio-capture.ts';
import { CaptureError } from '../../src/lib/stt/capture-error.ts';
import type { DictationEngine } from '../../src/hooks/use-dictation.ts';
import type { ShortcutHost } from '../../src/hooks/use-dictation-shortcut.ts';
import { TARGET_SAMPLE_RATE } from '../../src/lib/stt/pcm.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceToken: 'token-a' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...patch });
const speech = (): Float32Array => new Float32Array(TARGET_SAMPLE_RATE).fill(0.2);

interface FakeHost {
  readonly host: CaptureHost;
  openMic(): void;
  denyMic(error: unknown): void;
  emit(samples: Float32Array): void;
}

/**
 * Every `openMicrophone()` arms a FRESH prompt, the way a real browser does, so
 * a retry after a refusal is a new decision rather than the old rejection again.
 */
const fakeCaptureHost = (): FakeHost => {
  const pending: {
    resolve: ((stream: MicrophoneStream) => void) | null;
    reject: ((error: unknown) => void) | null;
  } = { resolve: null, reject: null };
  const arm = (): Promise<MicrophoneStream> =>
    new Promise<MicrophoneStream>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
  const state: { sink: ((samples: Float32Array) => void) | null } = { sink: null };
  const graph: CaptureGraph = {
    inputSampleRate: TARGET_SAMPLE_RATE,
    flush: async () => undefined,
    createAnalyser: () => null,
    release: () => undefined,
  };
  return {
    host: {
      openMicrophone: arm,
      buildGraph: async (_microphone, sink) => {
        state.sink = sink;
        return graph;
      },
      watchHidden: () => () => undefined,
    },
    openMic: () => pending.resolve?.({ stream: {} }),
    denyMic: error => pending.reject?.(error),
    emit: samples => state.sink?.(samples),
  };
};

const engineOf = (text: string): DictationEngine => ({ transcribe: async () => text });

const controlProps = (overrides: Partial<DictationControlProps> = {}): DictationControlProps => ({
  daemon,
  draft: '',
  onDraftChange: () => undefined,
  settings: settingsWith(),
  captureHost: null,
  engine: engineOf('dictated words'),
  waveformRuntime: () => null,
  ...overrides,
});

const micButton = (container: HTMLElement): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dictate a message"], button[aria-label="Show dictation recorder"]',
    ),
    'the mic button',
  );

const panel = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-dictation-panel]');

describe('dictationStatusCopy', () => {
  it('names the real step for every phase', () => {
    expect(dictationStatusCopy('requesting')).toContain('permission');
    expect(dictationStatusCopy('recording')).toBe('Recording…');
    expect(dictationStatusCopy('transcribing')).toContain('on your daemon');
    expect(dictationStatusCopy('idle')).toBe('');
  });

  it('prefers the real failure message over the generic one', () => {
    expect(dictationStatusCopy('error', 'Microphone blocked.')).toBe('Microphone blocked.');
    expect(dictationStatusCopy('error')).toBe('Dictation failed.');
  });
});

describe('dictationTriggerStartsFresh', () => {
  it('starts a new take only from a clean idle', () => {
    expect(dictationTriggerStartsFresh({ phase: 'idle', hasError: false, wasCapturing: false })).toBe(true);
  });

  it('resumes rather than restarts a live, failed or finished flow', () => {
    expect(dictationTriggerStartsFresh({ phase: 'recording', hasError: false, wasCapturing: true })).toBe(false);
    expect(dictationTriggerStartsFresh({ phase: 'idle', hasError: true, wasCapturing: false })).toBe(false);
    expect(dictationTriggerStartsFresh({ phase: 'idle', hasError: false, wasCapturing: true })).toBe(false);
  });
});

describe('<DictationControl>', () => {
  it('renders nothing at all when the browser cannot record', async () => {
    const view = await mount(<DictationControl {...controlProps()} />);
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('renders nothing when the reader has switched dictation off', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(
      <DictationControl {...controlProps({ captureHost: mic.host, settings: settingsWith({ enabled: false }) })} />,
    );
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('advertises the reader-s own chord on the button', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(
      <DictationControl
        {...controlProps({
          captureHost: mic.host,
          settings: settingsWith({ shortcut: { code: 'KeyD', key: 'd', modifiers: ['Control', 'Shift'] } }),
        })}
      />,
    );
    const button = micButton(view.container);
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+D');
    expect(button.getAttribute('title')).toContain('Ctrl + Shift + D');
    expect(button.getAttribute('title')).toContain('Nothing is ever sent for you');
    await view.unmount();
  });

  it('shows the word as well as the icon in the desktop layout', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host, layout: 'full' })} />);
    expect(micButton(view.container).textContent).toContain('Dictate');
    await view.unmount();
  });

  it('opens the panel, records, and drops one transcript into the draft', async () => {
    const mic = fakeCaptureHost();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl
        {...controlProps({ captureHost: mic.host, draft: 'note:', onDraftChange: r => drafts.push(r.text) })}
      />,
    );
    expect(panel(view.container)).toBeNull();

    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).not.toBeNull();
    expect(micButton(view.container).getAttribute('aria-expanded')).toBe('true');

    await interact(() => mic.openMic());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');

    await interact(() => mic.emit(speech()));
    await interact(async () =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'), 'stop').click(),
    );

    expect(drafts).toEqual(['note: dictated words']);
    // A clean pass closes the panel by itself: there is no review step.
    expect(panel(view.container)).toBeNull();
    await view.unmount();
  });

  it('hides without cancelling, and the same button brings the flow back', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host })} />);
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label^="Hide dictation"]'), 'hide').click(),
    );
    expect(panel(view.container)).toBeNull();
    // Still recording: the button says so, and reopening must not restart.
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    expect(micButton(view.container).getAttribute('aria-label')).toBe('Show dictation recorder');

    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).not.toBeNull();
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('throws the take away on Cancel and closes', async () => {
    const mic = fakeCaptureHost();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl {...controlProps({ captureHost: mic.host, onDraftChange: r => drafts.push(r.text) })} />,
    );
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());
    await interact(() => mic.emit(speech()));
    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label="Cancel dictation"]'), 'cancel').click(),
    );
    expect(panel(view.container)).toBeNull();
    expect(drafts).toEqual([]);
    await view.unmount();
  });

  it('offers a retry that starts a genuinely new take after a failure', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host })} />);
    await interact(() => micButton(view.container).click());
    await interact(async () => {
      mic.denyMic(new CaptureError('permission-denied', 'Microphone access was blocked for this site.'));
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Microphone access was blocked');

    // Reopening a failed flow must NOT silently restart it behind the message.
    await interact(() => micButton(view.container).click());
    expect(view.container.textContent).toContain('Microphone access was blocked');

    await interact(() =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label="Try again"]'), 'retry').click(),
    );
    expect(view.container.textContent).not.toContain('Microphone access was blocked');
    await interact(() => mic.openMic());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('keeps the panel open on a correction failure, after the words have landed', async () => {
    const mic = fakeCaptureHost();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl
        {...controlProps({
          captureHost: mic.host,
          engine: engineOf('raw words'),
          settings: settingsWith({ enhancementProvider: 'groq' }),
          enhancementFetch: async () => new Response(JSON.stringify({ code: 'secret_missing' }), { status: 400 }),
          onDraftChange: r => drafts.push(r.text),
        })}
      />,
    );
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());
    await interact(() => mic.emit(speech()));
    await interact(async () =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'), 'stop').click(),
    );
    expect(drafts).toEqual(['raw words']);
    expect(panel(view.container)).not.toBeNull();
    expect(view.container.textContent).toContain('raw dictation was added');
    // Nothing to retry: the transcript is already in the draft.
    expect(view.container.querySelector('button[aria-label="Try again"]')).toBeNull();
    await view.unmount();
  });

  it('names a take that captured nothing instead of closing silently', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host })} />);
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());
    await interact(() => mic.emit(new Float32Array(8)));
    await interact(async () =>
      must(view.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'), 'stop').click(),
    );
    expect(view.container.textContent).toContain('No speech was captured');
    expect(view.container.querySelector('button[aria-label="Record again"]')).not.toBeNull();
    await view.unmount();
  });

  it('runs an elapsed clock only while the microphone is open', async () => {
    const mic = fakeCaptureHost();
    const clock = { value: 0 };
    const view = await mount(
      <DictationControl {...controlProps({ captureHost: mic.host, now: () => clock.value, clockIntervalMs: 1 })} />,
    );
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());
    expect(view.container.textContent).toContain('0:00');

    clock.value = 65_000;
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    expect(view.container.textContent).toContain('1:05');
    await view.unmount();
  });

  it('closes and stays closed when dictation is switched off mid-flow', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host })} />);
    await interact(() => micButton(view.container).click());
    await interact(() => mic.openMic());
    await view.render(
      <DictationControl {...controlProps({ captureHost: mic.host, settings: settingsWith({ enabled: false }) })} />,
    );
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('refuses to open while the host has disabled the control', async () => {
    const mic = fakeCaptureHost();
    const view = await mount(<DictationControl {...controlProps({ captureHost: mic.host, disabled: true })} />);
    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).toBeNull();
    await view.unmount();
  });

  it('starts and stops from the reader-s push-to-talk chord', async () => {
    const mic = fakeCaptureHost();
    const listeners = new Map<string, (event: Event) => void>();
    const shortcutHost: ShortcutHost = {
      keys: {
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: type => listeners.delete(type),
      },
      visibility: { addEventListener: () => undefined, removeEventListener: () => undefined },
      visibilityState: () => 'visible',
      now: () => 0,
    };
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    const view = await mount(
      <DictationControl
        {...controlProps({ captureHost: mic.host, shortcutHost, composerRef: { current: composer } })}
      />,
    );

    const press = (type: 'keydown' | 'keyup'): void => {
      const event = new KeyboardEvent(type, { key: 'Alt', code: 'AltLeft', altKey: type === 'keydown' });
      Object.defineProperty(event, 'target', { value: composer });
      listeners.get(type)?.(event);
    };

    await interact(() => press('keydown'));
    expect(panel(view.container)).not.toBeNull();
    await interact(() => mic.openMic());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');

    // A hold this long finishes on release rather than latching.
    shortcutHost.now = () => 5_000;
    await interact(() => mic.emit(speech()));
    await interact(async () => press('keyup'));
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('false');

    composer.remove();
    await view.unmount();
  });
});
