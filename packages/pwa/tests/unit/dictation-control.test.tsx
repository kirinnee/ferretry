import { describe, expect, it } from 'bun:test';
import {
  DictationControl,
  type DictationControlProps,
  dictationStatusCopy,
  dictationTriggerStartsFresh,
} from '../../src/components/dictation-control.tsx';
import type { ShortcutHost } from '../../src/hooks/use-dictation-shortcut.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import {
  type FakeRecognitionProvider,
  fakeRecognitionProvider,
  unsupportedRecognitionProvider,
} from '../support/browser-recognition.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceToken: 'token-a' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...patch });

/**
 * A browser that settles Stop promptly, so one click of Stop is one whole take.
 * The finish/settle race itself belongs to the hook's own suite.
 */
const promptRecognition = (): FakeRecognitionProvider => fakeRecognitionProvider({ endsOnStop: true });

/**
 * `shortcutHost: null` by default. Omitting it binds the real `window`, which
 * would leave every suite in this file sharing one document-level chord.
 */
const controlProps = (overrides: Partial<DictationControlProps> = {}): DictationControlProps => ({
  daemon,
  draft: '',
  onDraftChange: () => undefined,
  settings: settingsWith(),
  shortcutHost: null,
  waveformRuntime: () => null,
  ...overrides,
});

const MIC_LABELS = ['Dictate a message', 'Show dictation recorder', 'Dictation unavailable in this browser'] as const;

const micButton = (container: HTMLElement): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>(MIC_LABELS.map(label => `button[aria-label="${label}"]`).join(', ')),
    'the mic button',
  );

const panel = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-dictation-panel]');

const clickLabelled = async (container: HTMLElement, selector: string, what: string): Promise<void> => {
  await interact(() => must(container.querySelector<HTMLButtonElement>(selector), what).click());
};

/** Open the panel and reach a live engine. */
const openAndBegin = async (container: HTMLElement, provider: FakeRecognitionProvider): Promise<void> => {
  await interact(() => micButton(container).click());
  await interact(() => provider.begin());
};

const stop = (container: HTMLElement): Promise<void> =>
  clickLabelled(container, 'button[aria-label^="Stop recording"]', 'the stop button');

describe('dictationStatusCopy', () => {
  it('names the real step for every phase', () => {
    expect(dictationStatusCopy('requesting')).toContain('permission');
    expect(dictationStatusCopy('recording')).toBe('Recording…');
    expect(dictationStatusCopy('transcribing')).toBe('Finishing in your browser…');
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
  it('stays visible in a browser without recognition, and says why when opened', async () => {
    const view = await mount(<DictationControl {...controlProps({ recognition: unsupportedRecognitionProvider() })} />);
    // Hiding the control would read as a broken click path, not as absence.
    const button = micButton(view.container);
    expect(button.getAttribute('aria-label')).toBe('Dictation unavailable in this browser');
    expect(button.getAttribute('title')).toContain('browser-specific reason');

    await interact(() => button.click());
    expect(panel(view.container)).not.toBeNull();
    expect(view.container.textContent).toContain('does not support dictation for web apps');
    await view.unmount();
  });

  it('renders nothing when the reader has switched dictation off', async () => {
    const view = await mount(
      <DictationControl
        {...controlProps({ recognition: promptRecognition(), settings: settingsWith({ enabled: false }) })}
      />,
    );
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('advertises the reader-s own chord on the button', async () => {
    const view = await mount(
      <DictationControl
        {...controlProps({
          recognition: promptRecognition(),
          settings: settingsWith({ shortcut: { code: 'KeyD', key: 'd', modifiers: ['Control', 'Shift'] } }),
        })}
      />,
    );
    const button = micButton(view.container);
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+D');
    expect(button.getAttribute('title')).toContain('Ctrl + Shift + D');
    expect(button.getAttribute('title')).toContain('Recognition is handled by this browser');
    await view.unmount();
  });

  it('shows the word as well as the icon in the desktop layout', async () => {
    const view = await mount(
      <DictationControl {...controlProps({ recognition: promptRecognition(), layout: 'full' })} />,
    );
    expect(micButton(view.container).textContent).toContain('Dictate');
    await view.unmount();
  });

  it('opens the panel, records, and drops one transcript into the draft', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl
        {...controlProps({ recognition: provider, draft: 'note:', onDraftChange: r => drafts.push(r.text) })}
      />,
    );
    expect(panel(view.container)).toBeNull();

    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).not.toBeNull();
    expect(micButton(view.container).getAttribute('aria-expanded')).toBe('true');

    await interact(() => provider.begin());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');

    await interact(() => provider.speak('dictated words'));
    // The provisional caption is read-only: what lands is the settled result.
    expect(view.container.textContent).toContain('dictated words');
    await stop(view.container);

    expect(drafts).toEqual(['note: dictated words']);
    // A clean pass closes the panel by itself: there is no review step.
    expect(panel(view.container)).toBeNull();
    await view.unmount();
  });

  it('hides without cancelling, and the same button brings the flow back', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider })} />);
    await openAndBegin(view.container, provider);

    await clickLabelled(view.container, 'button[aria-label^="Hide dictation"]', 'the hide button');
    expect(panel(view.container)).toBeNull();
    // Still recording: the button says so, and reopening must not restart.
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    expect(micButton(view.container).getAttribute('aria-label')).toBe('Show dictation recorder');

    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).not.toBeNull();
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    expect(provider.created).toBe(1);
    await view.unmount();
  });

  it('throws the take away on Cancel and closes', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, onDraftChange: r => drafts.push(r.text) })} />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('never mind'));
    await clickLabelled(view.container, 'button[aria-label="Cancel dictation"]', 'the cancel button');
    expect(panel(view.container)).toBeNull();
    expect(drafts).toEqual([]);
    expect(provider.recognition.aborts).toBe(1);
    await view.unmount();
  });

  it('offers a retry that starts a genuinely new take after a failure', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider })} />);
    await interact(() => micButton(view.container).click());
    await interact(() => provider.fail('not-allowed', 'Microphone access was blocked for this site.'));
    expect(view.container.textContent).toContain('Microphone access was blocked');

    // Reopening a failed flow must NOT silently restart it behind the message.
    await interact(() => micButton(view.container).click());
    expect(view.container.textContent).toContain('Microphone access was blocked');

    await clickLabelled(view.container, 'button[aria-label="Try again"]', 'the retry button');
    expect(view.container.textContent).not.toContain('Microphone access was blocked');
    await interact(() => provider.begin());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    expect(provider.created).toBe(2);
    await view.unmount();
  });

  it('keeps the panel open on a correction failure, after the words have landed', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl
        {...controlProps({
          recognition: provider,
          settings: settingsWith({ enhancementProvider: 'groq' }),
          enhancementFetch: async () => new Response(JSON.stringify({ code: 'secret_missing' }), { status: 400 }),
          onDraftChange: r => drafts.push(r.text),
        })}
      />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('raw words'));
    await stop(view.container);

    expect(drafts).toEqual(['raw words']);
    expect(panel(view.container)).not.toBeNull();
    expect(view.container.textContent).toContain('raw dictation was added');
    // Nothing to retry: the transcript is already in the draft.
    expect(view.container.querySelector('button[aria-label="Try again"]')).toBeNull();
    await view.unmount();
  });

  it('names a take that captured nothing instead of closing silently', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider })} />);
    await openAndBegin(view.container, provider);
    await stop(view.container);
    expect(view.container.textContent).toContain('No speech was captured');
    expect(view.container.querySelector('button[aria-label="Record again"]')).not.toBeNull();
    await view.unmount();
  });

  it('runs an elapsed clock only while the microphone is open', async () => {
    const provider = promptRecognition();
    const clock = { value: 0 };
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, now: () => clock.value, clockIntervalMs: 1 })} />,
    );
    await openAndBegin(view.container, provider);
    expect(view.container.textContent).toContain('0:00');

    clock.value = 65_000;
    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    expect(view.container.textContent).toContain('1:05');
    await view.unmount();
  });

  it('closes and stays closed when dictation is switched off mid-flow', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider })} />);
    await openAndBegin(view.container, provider);
    await view.render(
      <DictationControl {...controlProps({ recognition: provider, settings: settingsWith({ enabled: false }) })} />,
    );
    expect(view.container.querySelector('button')).toBeNull();
    await view.unmount();
  });

  it('refuses to open while the host has disabled the control', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider, disabled: true })} />);
    await interact(() => micButton(view.container).click());
    expect(panel(view.container)).toBeNull();
    expect(provider.created).toBe(0);
    await view.unmount();
  });

  it('starts and stops from the reader-s push-to-talk chord', async () => {
    const provider = promptRecognition();
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
        {...controlProps({ recognition: provider, shortcutHost, composerRef: { current: composer } })}
      />,
    );

    const press = (type: 'keydown' | 'keyup'): void => {
      const event = new KeyboardEvent(type, { key: 'Alt', code: 'AltLeft', altKey: type === 'keydown' });
      Object.defineProperty(event, 'target', { value: composer });
      listeners.get(type)?.(event);
    };

    await interact(() => press('keydown'));
    expect(panel(view.container)).not.toBeNull();
    await interact(() => provider.begin());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');

    // A hold this long finishes on release rather than latching.
    shortcutHost.now = () => 5_000;
    await interact(() => provider.speak('held words'));
    await interact(async () => press('keyup'));
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('false');

    composer.remove();
    await view.unmount();
  });

  it('binds the ambient browser chord when no host is supplied', async () => {
    const provider = promptRecognition();
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    const view = await mount(
      <DictationControl
        {...controlProps({ recognition: provider, shortcutHost: undefined, composerRef: { current: composer } })}
      />,
    );

    // The real window is the event target now, so a genuine key press reaches it.
    await interact(() => {
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true }),
      );
    });
    expect(panel(view.container)).not.toBeNull();

    await view.unmount();
    composer.remove();
  });
});
