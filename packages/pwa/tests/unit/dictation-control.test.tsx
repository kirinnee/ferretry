import { describe, expect, it } from 'bun:test';
import { ON_DEVICE_MODELS } from '../../src/lib/stt/model-catalog.ts';
import type { OnDeviceVoice } from '../../src/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../src/lib/stt/on-device-voices.ts';
import type { FyApiClient } from '@ferretry/protocol/client';
import * as React from 'react';
import {
  DictationControl,
  type DictationControlProps,
  dictationStatusCopy,
  dictationTriggerStartsFresh,
} from '../../src/components/dictation-control.tsx';
import type { ShortcutHost } from '../../src/hooks/use-dictation-shortcut.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { type AppStore, DaemonClientProvider, StoreProvider } from '../../src/lib/store.tsx';
import { DICTATION_DEBUG_KEY, DictationDebugLog } from '../../src/lib/stt/dictation-debug.ts';
import { browserMicMeter } from '../../src/lib/stt/level-monitor.ts';
import type { ParakeetVoice } from '../../src/lib/stt/parakeet-voice.ts';
import { DeviceSpeedupKeys } from '../../src/lib/stt/speedup-keys.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import {
  type FakeRecognitionProvider,
  fakeRecognitionProvider,
  unsupportedRecognitionProvider,
} from '../support/browser-recognition.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  engine: 'browser',
  ...patch,
});

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

const reviewText = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector<HTMLTextAreaElement>('textarea[data-review-text]'), 'the review text');

const stop = (container: HTMLElement): Promise<void> =>
  clickLabelled(container, 'button[aria-label^="Stop recording"]', 'the stop button');

describe('dictationStatusCopy', () => {
  it('names the real step for every phase', () => {
    expect(dictationStatusCopy('requesting')).toContain('permission');
    expect(dictationStatusCopy('recording')).toBe('Recording…');
    expect(dictationStatusCopy('transcribing')).toBe('Finishing in your browser…');
    expect(dictationStatusCopy('transcribing', undefined, 'parakeet')).toBe('Transcribing on this device…');
    expect(dictationStatusCopy('review')).toBe('Review the text, then insert it.');
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
    expect(dictationTriggerStartsFresh({ phase: 'review', hasError: false, wasCapturing: true })).toBe(false);
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
    expect(button.getAttribute('title')).toContain('Your browser’s speech service transcribes it');
    await view.unmount();
  });

  it('shows the word as well as the icon in the desktop layout', async () => {
    const view = await mount(
      <DictationControl {...controlProps({ recognition: promptRecognition(), layout: 'full' })} />,
    );
    expect(micButton(view.container).textContent).toContain('Dictate');
    await view.unmount();
  });

  it('opens the panel, records, reviews the take, and inserts it only on Insert', async () => {
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

    // Stop reaches the review box, not the draft.
    expect(drafts).toEqual([]);
    expect(panel(view.container)).not.toBeNull();
    expect(reviewText(view.container).value).toBe('dictated words');

    await clickLabelled(view.container, 'button[aria-label="Insert at the cursor"]', 'the insert button');
    expect(drafts).toEqual(['note: dictated words']);
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

  it('discards a reviewed take without touching the draft, and closes', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, onDraftChange: r => drafts.push(r.text) })} />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('not this'));
    await stop(view.container);

    await clickLabelled(view.container, 'button[aria-label="Discard dictation"]', 'the discard button');
    expect(drafts).toEqual([]);
    expect(panel(view.container)).toBeNull();
    expect(micButton(view.container).getAttribute('aria-label')).toBe('Dictate a message');
    await view.unmount();
  });

  it('discards on Escape from the review text', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, onDraftChange: r => drafts.push(r.text) })} />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('not this'));
    await stop(view.container);
    await interact(() => pressKey(reviewText(view.container), 'Escape'));
    expect(drafts).toEqual([]);
    expect(panel(view.container)).toBeNull();
    await view.unmount();
  });

  it('inserts the raw transcript when the person switches to it', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl
        {...controlProps({
          recognition: provider,
          settings: settingsWith({ enhancementProvider: 'groq' }),
          enhancementFetch: async () => Response.json({ text: 'Cleaned words.' }),
          onDraftChange: r => drafts.push(r.text),
        })}
      />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('cleaned words'));
    await stop(view.container);
    expect(reviewText(view.container).value).toBe('Cleaned words.');

    await interact(() =>
      must(
        [...view.container.querySelectorAll('button')].find(candidate => candidate.textContent === 'Raw'),
        'the raw segment',
      ).click(),
    );
    await interact(() => pressKey(reviewText(view.container), 'Enter'));
    expect(drafts).toEqual(['cleaned words']);
    await view.unmount();
  });

  it('brings a hidden panel back when the take lands, so it is never stranded', async () => {
    const provider = fakeRecognitionProvider();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider })} />);
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('quiet words'));
    await stop(view.container);
    // Recognition has not settled yet: the panel is still transcribing. Hide it.
    await clickLabelled(view.container, 'button[aria-label^="Hide dictation"]', 'the hide button');
    expect(panel(view.container)).toBeNull();

    await interact(async () => {
      provider.end();
      await Promise.resolve();
    });
    expect(panel(view.container)).not.toBeNull();
    expect(reviewText(view.container).value).toBe('quiet words');
    await view.unmount();
  });

  it('records again from the review box and drops the old take', async () => {
    const provider = promptRecognition();
    const drafts: string[] = [];
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, onDraftChange: r => drafts.push(r.text) })} />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('first try'));
    await stop(view.container);

    await clickLabelled(view.container, 'button[aria-label="Record again"]', 'the record-again button');
    await interact(() => provider.begin());
    expect(micButton(view.container).getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('[data-review-text]')).toBeNull();
    expect(provider.created).toBe(2);
    expect(drafts).toEqual([]);
    await view.unmount();
  });

  it('reviews the raw words, with the reason, when a correction fails', async () => {
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

    // Nothing lands until Insert, and the box says why it is showing the raw words.
    expect(drafts).toEqual([]);
    expect(view.container.querySelector('[data-review-notice="cleanup-failed"]')).not.toBeNull();
    expect(reviewText(view.container).value).toBe('raw words');
    expect(view.container.querySelector('button[aria-label="Try again"]')).toBeNull();

    await clickLabelled(view.container, 'button[aria-label="Insert at the cursor"]', 'the insert button');
    expect(drafts).toEqual(['raw words']);
    expect(panel(view.container)).toBeNull();
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

/** A controlled composer: the draft the control reads follows what it wrote, as the real composer does. */
const InsertHost = (props: {
  provider: FakeRecognitionProvider;
  initial?: string;
  writes: string[];
  settings?: SttSettings;
  enhancementFetch?: DictationControlProps['enhancementFetch'];
}): React.ReactElement => {
  const [draft, setDraft] = React.useState(props.initial ?? '');
  return (
    <div>
      <button type="button" data-type-more onClick={() => setDraft(current => current + ' more')}>
        type
      </button>
      <DictationControl
        {...controlProps({
          recognition: props.provider,
          draft,
          settings: props.settings ?? settingsWith({ afterDictation: 'insert' }),
          enhancementFetch: props.enhancementFetch,
          onDraftChange: result => {
            props.writes.push(result.text);
            setDraft(result.text);
          },
        })}
      />
    </div>
  );
};

const inserted = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-dictation-inserted]');

const undoButton = (container: HTMLElement): HTMLButtonElement =>
  must(
    container.querySelector<HTMLButtonElement>('button[aria-label="Undo the inserted dictation"]'),
    'the undo button',
  );

describe('<DictationControl> insert straight away', () => {
  it('puts the take in the draft, closes the panel, and offers Undo — with no Insert press', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(<InsertHost provider={provider} initial="note:" writes={writes} />);
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('dictated words'));
    await stop(view.container);

    expect(writes).toEqual(['note: dictated words']);
    expect(panel(view.container)).toBeNull();
    expect(view.container.querySelector('textarea[data-review-text]')).toBeNull();
    expect(inserted(view.container)?.textContent).toContain('Inserted');
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Inserted');
    await view.unmount();
  });

  it('Undo puts the draft back exactly as it was, once, and the note goes', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(<InsertHost provider={provider} initial="note:" writes={writes} />);
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('dictated words'));
    await stop(view.container);

    await interact(() => undoButton(view.container).click());
    expect(writes).toEqual(['note: dictated words', 'note:']);
    expect(inserted(view.container)).toBeNull();
    expect(view.container.querySelector('button[aria-label="Undo the inserted dictation"]')).toBeNull();
    await view.unmount();
  });

  it('takes the note away, rather than overwrite typing, once the draft is edited', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(<InsertHost provider={provider} initial="note:" writes={writes} />);
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('dictated words'));
    await stop(view.container);
    expect(inserted(view.container)).not.toBeNull();

    await clickLabelled(view.container, 'button[data-type-more]', 'the typing stand-in');
    expect(inserted(view.container)).toBeNull();
    expect(writes).toEqual(['note: dictated words']);
    await view.unmount();
  });

  it('shows the panel with the reason, and inserts nothing, when the correction fails', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(
      <InsertHost
        provider={provider}
        writes={writes}
        settings={settingsWith({ afterDictation: 'insert', enhancementProvider: 'groq' })}
        enhancementFetch={async () => new Response(JSON.stringify({ code: 'secret_missing' }), { status: 400 })}
      />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('raw words'));
    await stop(view.container);

    expect(writes).toEqual([]);
    expect(inserted(view.container)).toBeNull();
    expect(panel(view.container)).not.toBeNull();
    expect(view.container.querySelector('[data-review-notice="cleanup-failed"]')).not.toBeNull();
    expect(reviewText(view.container).value).toBe('raw words');
    await view.unmount();
  });

  it('still names a take that captured nothing, and inserts nothing', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(<InsertHost provider={provider} writes={writes} />);
    await openAndBegin(view.container, provider);
    await stop(view.container);

    expect(writes).toEqual([]);
    expect(inserted(view.container)).toBeNull();
    expect(view.container.textContent).toContain('No speech was captured');
    await view.unmount();
  });

  it('says on the button which way the setting goes', async () => {
    const insertView = await mount(<InsertHost provider={promptRecognition()} writes={[]} />);
    expect(micButton(insertView.container).getAttribute('title')).toContain('goes into your draft when it is ready');
    await insertView.unmount();

    const reviewView = await mount(
      <InsertHost provider={promptRecognition()} writes={[]} settings={settingsWith({ afterDictation: 'review' })} />,
    );
    expect(micButton(reviewView.container).getAttribute('title')).toContain('review the text before it reaches');
    await reviewView.unmount();
  });

  it('follows the setting for push-to-talk: a released hold inserts with no review', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
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
        {...controlProps({
          recognition: provider,
          shortcutHost,
          composerRef: { current: composer },
          settings: settingsWith({ afterDictation: 'insert' }),
          onDraftChange: result => writes.push(result.text),
        })}
      />,
    );
    const press = (type: 'keydown' | 'keyup'): void => {
      const event = new KeyboardEvent(type, { key: 'Alt', code: 'AltLeft', altKey: type === 'keydown' });
      Object.defineProperty(event, 'target', { value: composer });
      listeners.get(type)?.(event);
    };

    await interact(() => press('keydown'));
    await interact(() => provider.begin());
    shortcutHost.now = () => 5_000;
    await interact(() => provider.speak('held words'));
    await interact(async () => press('keyup'));

    expect(writes).toEqual(['held words']);
    expect(panel(view.container)).toBeNull();
    expect(inserted(view.container)).not.toBeNull();

    composer.remove();
    await view.unmount();
  });

  it('still parks the take for review when the person reviews first', async () => {
    const provider = promptRecognition();
    const writes: string[] = [];
    const view = await mount(
      <InsertHost provider={provider} writes={writes} settings={settingsWith({ afterDictation: 'review' })} />,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('dictated words'));
    await stop(view.container);

    expect(writes).toEqual([]);
    expect(inserted(view.container)).toBeNull();
    expect(reviewText(view.container).value).toBe('dictated words');
    await view.unmount();
  });
});

describe('<DictationControl> names the engine that will listen', () => {
  it('says Parakeet transcribes on this device when it is chosen and available', async () => {
    const voice = { support: { available: true } } as unknown as ParakeetVoice;
    const store = { voice, carrier: { fetch: async () => new Response() } } as unknown as AppStore;
    const view = await mount(
      <StoreProvider store={store}>
        <DictationControl {...controlProps({ settings: settingsWith({ engine: 'parakeet' }) })} />
      </StoreProvider>,
    );
    expect(micButton(view.container).getAttribute('title')).toContain('Parakeet transcribes on this device');
    await view.unmount();
  });

  it('dictates with the default for a phone or a computer before any engine is picked', async () => {
    const phone = await mount(
      <StoreProvider store={voicesStore()}>
        <DictationControl {...controlProps({ settings: settingsWith({ engine: null }), deviceClass: 'phone' })} />
      </StoreProvider>,
    );
    expect(micButton(phone.container).getAttribute('title')).toContain('Parakeet 110M transcribes on this device');
    await phone.unmount();
    const computer = await mount(
      <StoreProvider store={voicesStore()}>
        <DictationControl {...controlProps({ settings: settingsWith({ engine: null }), deviceClass: 'computer' })} />
      </StoreProvider>,
    );
    expect(micButton(computer.container).getAttribute('title')).toContain('Parakeet transcribes on this device');
    await computer.unmount();
  });
});

/** A store holding a voice for every on-device engine, each able to run here. */
const voicesStore = (): AppStore => {
  const voices = new OnDeviceVoices(
    ON_DEVICE_MODELS.map(model => ({ model, support: { available: true } }) as unknown as OnDeviceVoice),
  );
  return {
    voice: voices.get('parakeet'),
    voices,
    carrier: { fetch: async () => new Response() },
  } as unknown as AppStore;
};

describe('<DictationControl> machine default engine', () => {
  const parakeetStore = () => {
    const voice = { support: { available: true } } as unknown as ParakeetVoice;
    return { voice, carrier: { fetch: async () => new Response() } } as unknown as AppStore;
  };

  const machineClient = (text: string, reads: string[]) => async () =>
    ({
      request: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
        reads.push(path);
        return schema.parse({
          path: 'voice.yaml',
          absolutePath: '/state/config/voice.yaml',
          kind: 'voice',
          schema: 'voice',
          exists: true,
          text,
          etag: 'etag-voice',
          state: 'ok',
          issues: [],
        });
      },
    }) as unknown as FyApiClient;

  const settledTitle = async (container: HTMLElement, wanted: string): Promise<string> => {
    await settleUntil(
      () => (micButton(container).getAttribute('title') ?? '').includes(wanted),
      `the mic title to name "${wanted}"`,
      interact,
    );
    return micButton(container).getAttribute('title') ?? '';
  };

  it("dictates with the machine's default engine when this device has picked none", async () => {
    const reads: string[] = [];
    const view = await mount(
      <StoreProvider store={parakeetStore()}>
        <DaemonClientProvider client={machineClient('defaultEngine: parakeet\n', reads)}>
          <DictationControl {...controlProps({ settings: settingsWith({ engine: null }) })} />
        </DaemonClientProvider>
      </StoreProvider>,
    );
    expect(await settledTitle(view.container, 'Parakeet transcribes on this device')).not.toContain('Choose a voice');
    expect(reads).toEqual(['/v1/config/file?path=voice.yaml']);
    await view.unmount();
  });

  it('falls back to the device default when the machine names none', async () => {
    const reads: string[] = [];
    const view = await mount(
      <StoreProvider store={voicesStore()}>
        <DaemonClientProvider client={machineClient('postProcessing:\n  provider: off\n', reads)}>
          <DictationControl {...controlProps({ settings: settingsWith({ engine: null }), deviceClass: 'phone' })} />
        </DaemonClientProvider>
      </StoreProvider>,
    );
    await settleUntil(() => reads.length === 1, "the machine's voice.yaml to be read", interact);
    expect(micButton(view.container).getAttribute('title')).toContain('Parakeet 110M transcribes on this device');
    await view.unmount();
  });

  it("reads a machine default of Parakeet as the phone's Parakeet on a phone", async () => {
    const view = await mount(
      <StoreProvider store={voicesStore()}>
        <DaemonClientProvider client={machineClient('defaultEngine: parakeet\n', [])}>
          <DictationControl {...controlProps({ settings: settingsWith({ engine: null }), deviceClass: 'phone' })} />
        </DaemonClientProvider>
      </StoreProvider>,
    );
    expect(await settledTitle(view.container, 'Parakeet 110M transcribes on this device')).not.toContain('Choose');
    await view.unmount();
  });

  it("never reads the machine's default once this device has picked an engine", async () => {
    const reads: string[] = [];
    const view = await mount(
      <DaemonClientProvider client={machineClient('defaultEngine: parakeet\n', reads)}>
        <DictationControl {...controlProps({ settings: settingsWith({ engine: 'browser' }) })} />
      </DaemonClientProvider>,
    );
    await interact(() => new Promise(resolve => setTimeout(resolve, 10)));
    expect(reads).toEqual([]);
    expect(micButton(view.container).getAttribute('title')).not.toContain('Parakeet');
    await view.unmount();
  });
});

describe('<DictationControl> input meter', () => {
  class FakeContext {
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createAnalyser() {
      return { getFloatTimeDomainData: () => undefined };
    }
    async close() {}
  }

  // happy-dom's MediaStream has no tracks API; a browser's does, and release walks it.
  const realStream = (): MediaStream => Object.assign(new MediaStream(), { getTracks: () => [] });

  const meterOver = (stream: MediaStream, asked: { count: number }) =>
    browserMicMeter({
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            asked.count += 1;
            return stream;
          },
        },
      },
      AudioContext: FakeContext as never,
    });

  it('shows the bars while recording and takes them away on Stop, for browser voice', async () => {
    const provider = promptRecognition();
    const asked = { count: 0 };
    const view = await mount(
      <DictationControl {...controlProps({ recognition: provider, meter: meterOver(realStream(), asked) })} />,
    );
    await openAndBegin(view.container, provider);
    await settleUntil(() => panel(view.container)?.querySelector('canvas') != null, 'the input meter', interact);
    expect(asked.count).toBe(1);

    await stop(view.container);
    await settleUntil(() => panel(view.container)?.querySelector('canvas') == null, 'the meter to go', interact);
    await view.unmount();
  });

  it('shows no bars, and still records, when the page cannot open a meter', async () => {
    const provider = promptRecognition();
    const view = await mount(<DictationControl {...controlProps({ recognition: provider, meter: null })} />);
    await openAndBegin(view.container, provider);
    expect(panel(view.container)?.getAttribute('data-dictation-panel')).toBe('non-modal');
    expect(panel(view.container)?.querySelector('canvas') ?? null).toBeNull();
    await view.unmount();
  });
});

describe('<DictationControl> details of the clean-up call', () => {
  const keysThatRefuse = async (): Promise<DeviceSpeedupKeys> => {
    const records = new Map<string, unknown>();
    const keys = new DeviceSpeedupKeys(
      {
        get: async slot => records.get(slot),
        put: async (slot, value) => void records.set(slot, value),
        delete: async slot => void records.delete(slot),
      },
      crypto.subtle,
      async () => new Response('{}', { status: 401 }),
    );
    await keys.save('groq', 'gsk_test_0123456789abcdef');
    return keys;
  };
  const storeWith = async (enabled: boolean): Promise<AppStore> => {
    const values = new Map<string, string>(enabled ? [[DICTATION_DEBUG_KEY, 'on']] : []);
    return {
      speedupKeys: await keysThatRefuse(),
      dictationDebug: new DictationDebugLog({
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
      }),
      transcriptionLog: null,
      carrier: { fetch: async () => new Response() },
    } as unknown as AppStore;
  };
  const detailsLink = (): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Details');
  const take = async (enabled: boolean) => {
    const provider = promptRecognition();
    const view = await mount(
      <StoreProvider store={await storeWith(enabled)}>
        <DictationControl
          {...controlProps({ recognition: provider, settings: settingsWith({ enhancementProvider: 'groq' }) })}
        />
      </StoreProvider>,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.speak('raw words'));
    await stop(view.container);
    await settleUntil(() => view.container.querySelector('[data-review-text]') !== null, 'the review box', interact);
    return view;
  };

  it('offers Details, opens the record of the call, and closes it again', async () => {
    const view = await take(true);

    await interact(() => must(detailsLink(), 'the Details link').click());
    expect(document.body.textContent).toContain('Dictation details');
    expect(document.body.textContent).not.toContain('gsk_test');
    await interact(() =>
      must(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'), 'close').click(),
    );

    expect(document.body.textContent).not.toContain('Dictation details');
    await view.unmount();
  });

  it('offers no Details when dictation debug is off', async () => {
    const view = await take(false);

    expect(detailsLink()).toBeUndefined();
    await view.unmount();
  });
});

describe('<DictationControl> inline engine switch', () => {
  it('offers Parakeet after a browser take heard speech but returned no words, and writes the choice', async () => {
    const updates: unknown[] = [];
    const store = { stt: { update: (patch: unknown) => void updates.push(patch) } } as unknown as AppStore;
    const provider = promptRecognition();
    const view = await mount(
      <StoreProvider store={store}>
        <DictationControl {...controlProps({ recognition: provider })} />
      </StoreProvider>,
    );
    await openAndBegin(view.container, provider);
    await interact(() => provider.nomatch());
    await stop(view.container);

    const offer = [...view.container.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Use Parakeet'),
    );
    await interact(() => must(offer, 'the Use Parakeet button').click());
    expect(updates).toEqual([{ engine: 'parakeet' }]);
    await view.unmount();
  });
});

describe('<DictationControl> inline engine switch restart', () => {
  it('records again once the new engine arrives through settings', async () => {
    const provider = promptRecognition();
    const Host = (): React.ReactElement => {
      const [engine, setEngine] = React.useState<SttSettings['engine']>('browser');
      const store = { stt: { update: (patch: { engine: SttSettings['engine'] }) => setEngine(patch.engine) } };
      return (
        <StoreProvider store={store as unknown as AppStore}>
          <DictationControl {...controlProps({ recognition: provider, settings: settingsWith({ engine }) })} />
        </StoreProvider>
      );
    };
    const view = await mount(<Host />);
    await openAndBegin(view.container, provider);
    await interact(() => provider.nomatch());
    await stop(view.container);

    const offer = [...view.container.querySelectorAll('button')].find(button =>
      button.textContent?.includes('Use Parakeet'),
    );
    await interact(() => must(offer, 'the Use Parakeet button').click());

    const stillOffered = [...view.container.querySelectorAll('button')].some(button =>
      button.textContent?.includes('Use Parakeet'),
    );
    expect(stillOffered).toBe(false);
    await view.unmount();
  });
});
