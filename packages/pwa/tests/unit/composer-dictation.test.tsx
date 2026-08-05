/**
 * The composer's dictation slot, mounted in a real DOM.
 *
 * Dictation is optional here: a host that has no browser-local dictation
 * settings gets a composer with no microphone at all. When it is supplied, the
 * only thing dictation may do to this composer is replace the draft and move
 * the caret — there is no path from recognised words to a sent message, so this
 * suite asserts what landed in the textarea and that nothing was sent.
 */

import { describe, expect, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { type FakeRecognitionProvider, fakeRecognitionProvider } from '../support/browser-recognition.ts';
import { interact, mount, must } from '../support/dom.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'token-a',
});

/** Drafts must not leak between cases through a shared browser store. */
const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

const sent: string[] = [];
const api: Pick<IFyApiClient, 'send'> = {
  send: async (_id, input) => {
    sent.push(input.message);
    return {} as never;
  },
};

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the composer textarea');

const micButton = (container: HTMLElement): HTMLButtonElement =>
  must(container.querySelector<HTMLButtonElement>('button[aria-label="Dictate a message"]'), 'the mic button');

/** A browser that settles Stop promptly, so one Stop is one whole take. */
const promptRecognition = (): FakeRecognitionProvider => fakeRecognitionProvider({ endsOnStop: true });

/** Let the post-insert `requestAnimationFrame` caret restore run. */
const settleFrame = async (): Promise<void> => {
  await interact(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
};

describe('Composer dictation slot', () => {
  it('mounts no microphone at all when the host supplies no dictation settings', async () => {
    const composer = await mount(
      <Composer api={api} daemon={daemon} draftStore={new DaemonDraftStore(memoryStorage())} sessionId="plain" />,
    );
    expect(composer.container.querySelector('button[aria-label^="Dictate"]')).toBeNull();
    expect(composer.container.querySelector('[data-dictation-panel]')).toBeNull();
    await composer.unmount();
  });

  it('drops one finished take into the draft at the caret, and sends nothing', async () => {
    const provider = promptRecognition();
    const composer = await mount(
      <Composer
        api={api}
        daemon={daemon}
        dictationRecognition={provider}
        dictationSettings={DEFAULT_STT_SETTINGS}
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="dictated"
      />,
    );
    const textarea = textareaOf(composer.container);
    const before = sent.length;

    await interact(() => micButton(composer.container).click());
    await interact(() => provider.begin());
    await interact(() => provider.speak('ship it today'));
    await interact(() =>
      must(
        composer.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'),
        'the stop button',
      ).click(),
    );
    await settleFrame();

    expect(textarea.value).toBe('ship it today');
    expect(textarea.selectionStart).toBe('ship it today'.length);
    // THE ONLY OUTPUT is the draft. Dictation never submits for the reader.
    expect(sent).toHaveLength(before);
    await composer.unmount();
  });

  it('hands the landed caret to the autocomplete without summoning the keyboard', async () => {
    const provider = promptRecognition();
    // A trigger at the caret makes the autocomplete providers ask this daemon
    // for candidates. Nothing here is about that request, so it never leaves the
    // process: the assertion is that the list opened at all.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const composer = await mount(
      <Composer
        api={api}
        daemon={daemon}
        dictationRecognition={provider}
        // Correction off: this case is about the caret, and the exact words are
        // the assertion.
        dictationSettings={{ ...DEFAULT_STT_SETTINGS, enhancement: false }}
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="caret-synced"
      />,
    );
    const textarea = textareaOf(composer.container);

    await interact(() => micButton(composer.container).click());
    await interact(() => provider.begin());
    await interact(() => provider.speak('/'));
    await interact(() =>
      must(
        composer.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'),
        'the stop button',
      ).click(),
    );
    await settleFrame();

    expect(textarea.value).toBe('/');
    // The autocomplete controller was told where the caret landed, so a
    // reference the transcript ended on is offered immediately rather than
    // after the next keystroke.
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    // And the textarea was deliberately NOT focused: focusing it here opens the
    // phone keyboard over the words the reader just spoke to avoid typing.
    expect(document.activeElement).not.toBe(textarea);
    await composer.unmount();
    globalThis.fetch = realFetch;
  });

  it('forwards this session-s history reader only when the host actually has one', async () => {
    const asked: string[] = [];
    const withHistory: Pick<IFyApiClient, 'send'> & Partial<Pick<IFyApiClient, 'history'>> = {
      send: api.send,
      history: async sessionId => {
        asked.push(sessionId);
        return [];
      },
    };
    const provider = promptRecognition();
    const composer = await mount(
      <Composer
        api={withHistory}
        daemon={daemon}
        dictationRecognition={provider}
        dictationSettings={DEFAULT_STT_SETTINGS}
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="mined"
      />,
    );

    await interact(() => micButton(composer.container).click());
    await interact(() => provider.begin());
    await interact(() => provider.speak('some words'));
    await interact(() =>
      must(
        composer.container.querySelector<HTMLButtonElement>('button[aria-label^="Stop recording"]'),
        'the stop button',
      ).click(),
    );
    await settleFrame();

    // Vocabulary mining is scoped to the composer's own session, never another.
    expect(asked).toEqual(['mined']);
    await composer.unmount();
  });

  it('disables the microphone while the composer itself is disabled', async () => {
    const composer = await mount(
      <Composer
        api={api}
        daemon={daemon}
        dictationRecognition={promptRecognition()}
        dictationSettings={DEFAULT_STT_SETTINGS}
        disabled
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="stopped"
      />,
    );
    expect(micButton(composer.container).disabled).toBe(true);
    await composer.unmount();
  });
});
