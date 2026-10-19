import { describe, expect, it } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import {
  CONTEXT_FETCH_LIMIT,
  type DictationDraftResult,
  type DictationHandle,
  enhancementErrorFrom,
  extractContextMessages,
  hasUsableContext,
  type UseDictationOptions,
  useDictation,
  withinContextFetchBudget,
} from '../../src/hooks/use-dictation.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { BrowserRecognitionError } from '../../src/lib/stt/browser-recognition.ts';
import type { CaptureMonitor, MicMeter, MicMeterPort } from '../../src/lib/stt/level-monitor.ts';
import type { ParakeetSessionOptions } from '../../src/lib/stt/parakeet-session.ts';
import type { ParakeetVoice } from '../../src/lib/stt/parakeet-voice.ts';
import { RemoteEnhancementError } from '../../src/lib/stt/remote-enhancement.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import {
  type FakeRecognitionProvider,
  fakeRecognitionProvider,
  UNSUPPORTED_RECOGNITION,
  unsupportedRecognitionProvider,
} from '../support/browser-recognition.ts';
import { interact, mount } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  engine: 'browser',
  ...patch,
});

interface Harness {
  handle(): DictationHandle;
  drafts: DictationDraftResult[];
  render(next: Partial<UseDictationOptions>): Promise<void>;
  unmount(): Promise<void>;
}

/** Mounts the hook and exposes the live handle plus every draft it produced. */
/** `carrier`, when given, is the store's carrier router — the fetch the hook falls back to. */
const harness = async (initial: Partial<UseDictationOptions> = {}, carrier?: DaemonFetch): Promise<Harness> => {
  const drafts: DictationDraftResult[] = [];
  const latest: { handle: DictationHandle | null } = { handle: null };

  function Probe(props: UseDictationOptions) {
    latest.handle = useDictation(props);
    return <span data-phase={latest.handle.phase} />;
  }

  const propsFor = (overrides: Partial<UseDictationOptions>): UseDictationOptions => ({
    daemon,
    draft: '',
    settings: settingsWith(),
    onDraft: result => drafts.push(result),
    ...initial,
    ...overrides,
  });

  const wrap = (probe: ReactElement): ReactElement =>
    carrier === undefined ? (
      probe
    ) : (
      <StoreProvider store={{ carrier: { fetch: carrier } } as unknown as AppStore}>{probe}</StoreProvider>
    );
  const view = await mount(wrap(<Probe {...propsFor({})} />));
  return {
    handle: () => {
      if (latest.handle === null) throw new Error('the hook did not run');
      return latest.handle;
    },
    drafts,
    render: async next => view.render(wrap(<Probe {...propsFor(next)} />)),
    unmount: () => view.unmount(),
  };
};

/** Reach `recording` the way the browser does: gesture, then a live engine. */
const record = async (view: Harness, provider: FakeRecognitionProvider): Promise<void> => {
  await interact(() => view.handle().start());
  await interact(() => provider.begin());
};

/** Stop, then let the engine settle the take the way `end` does. */
const finishTake = async (view: Harness, provider: FakeRecognitionProvider): Promise<void> => {
  await interact(() => view.handle().stop());
  await interact(async () => {
    provider.end();
    await Promise.resolve();
  });
};

describe('withinContextFetchBudget', () => {
  it('returns the value when the request wins', async () => {
    expect(await withinContextFetchBudget(Promise.resolve('ok'), 1_000)).toBe('ok');
  });

  it('gives up rather than delaying the transcript', async () => {
    const never = new Promise<string>(() => undefined);
    expect(await withinContextFetchBudget(never, 1)).toBeUndefined();
  });

  it('never waits for a zero or negative budget forever', async () => {
    expect(await withinContextFetchBudget(new Promise<string>(() => undefined), 0)).toBeUndefined();
  });
});

describe('extractContextMessages', () => {
  const event = (type: string, text: unknown): FyEvent => ({ type, data: { text } }) as unknown as FyEvent;

  it('answers nothing for a missing or non-array page', () => {
    expect(extractContextMessages(undefined)).toEqual([]);
    expect(extractContextMessages('not a page' as unknown as readonly FyEvent[])).toEqual([]);
  });

  it('keeps only user and assistant text', () => {
    expect(
      extractContextMessages([
        event('chat.user', 'first'),
        event('tool.call', 'rm -rf'),
        event('chat.assistant.thinking', 'internal'),
        event('chat.assistant.text', 'second'),
      ]),
    ).toEqual(['first', 'second']);
  });

  it('skips malformed rows rather than failing the whole window', () => {
    expect(
      extractContextMessages([
        null as unknown as FyEvent,
        'row' as unknown as FyEvent,
        event('chat.user', 42),
        event('chat.user', '   '),
        event('chat.user', 'kept'),
      ]),
    ).toEqual(['kept']);
  });

  it('keeps at most the last ten messages', () => {
    const many = Array.from({ length: 14 }, (_, index) => event('chat.user', `m${index}`));
    expect(extractContextMessages(many)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13']);
  });
});

describe('hasUsableContext', () => {
  it('abstains below the five-message floor', () => {
    expect(hasUsableContext(['a', 'b', 'c', 'd'])).toBe(false);
    expect(hasUsableContext(['a', 'b', 'c', 'd', 'e'])).toBe(true);
  });
});

describe('enhancementErrorFrom', () => {
  it('namespaces a real provider code', () => {
    expect(enhancementErrorFrom(new RemoteEnhancementError('rate-limit', 'Slow down.'))).toEqual({
      code: 'enhancement-rate-limit',
      message: 'Slow down.',
    });
  });

  it('falls back for a codeless or non-error failure', () => {
    expect(enhancementErrorFrom(new Error('boom'))).toEqual({ code: 'enhancement-provider', message: 'boom' });
    expect(enhancementErrorFrom('nope').code).toBe('enhancement-provider');
    expect(enhancementErrorFrom('nope').message).toContain('raw dictation was kept');
  });
});

describe('useDictation', () => {
  it('fails closed, by name, in a browser with no speech recognition', async () => {
    const provider = unsupportedRecognitionProvider();
    const view = await harness({ recognition: provider });
    expect(view.handle().supported).toBe(false);

    await interact(() => view.handle().start());
    // Silence would read as a broken button; the reason is the whole point.
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error).toEqual({
      code: 'recognition-unavailable',
      message: UNSUPPORTED_RECOGNITION.reason ?? '',
    });
    expect(provider.created).toBe(0);
    await view.unmount();
  });

  it('carries the browser-specific reason rather than a generic sentence', async () => {
    const view = await harness({
      recognition: unsupportedRecognitionProvider({
        available: false,
        availability: 'ios-home-screen',
        implementation: 'webkit',
        reason: 'Open Ferretry in Safari to dictate.',
      }),
    });
    await interact(() => view.handle().start());
    expect(view.handle().error?.message).toBe('Open Ferretry in Safari to dictate.');
    await view.unmount();
  });

  it('takes one utterance from the browser to the draft, once', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, draft: 'typed' });
    expect(view.handle().supported).toBe(true);

    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('requesting');
    // The gesture must have reached the browser before any await could run.
    expect(provider.recognition.starts).toBe(1);

    await interact(() => provider.begin());
    expect(view.handle().phase).toBe('recording');
    expect(view.handle().recording).toBe(true);

    await interact(() => provider.result([{ text: 'hello wor', final: false }]));
    expect(view.handle().liveText).toBe('hello wor');
    await interact(() => provider.result([{ text: 'hello world', final: true }]));

    await finishTake(view, provider);
    expect(view.drafts).toEqual([{ text: 'typed hello world', caret: 17 }]);
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().liveText).toBe('');
    await view.unmount();
  });

  it('inserts at the live caret rather than where the draft started', async () => {
    const provider = fakeRecognitionProvider();
    const selectionRef = { current: { selectionStart: 5, selectionEnd: 5 } };
    const view = await harness({ recognition: provider, draft: 'start', selectionRef });
    await record(view, provider);
    // The reader keeps typing DURING the utterance; the commit must use this.
    await view.render({ draft: 'start end', selectionRef: { current: { selectionStart: 5, selectionEnd: 5 } } });
    await interact(() => provider.speak('hello world'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toBe('start hello world end');
    await view.unmount();
  });

  it('says nothing at all about a mis-tap that captured no speech', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await finishTake(view, provider);
    expect(view.drafts).toEqual([]);
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('names a blocked microphone instead of a generic failure', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.fail('not-allowed', 'Microphone access was blocked for this site.'));
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error).toEqual({
      code: 'permission-denied',
      message: 'Microphone access was blocked for this site.',
    });

    await interact(() => view.handle().dismissError());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('names a refusal thrown synchronously by start, and lets a retry through', async () => {
    const provider = fakeRecognitionProvider({ startFailure: { name: 'NotAllowedError' } });
    const view = await harness({ recognition: provider });
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('permission-denied');

    provider.startFailure = undefined;
    await record(view, provider);
    expect(view.handle().phase).toBe('recording');
    expect(provider.created).toBe(2);
    await view.unmount();
  });

  it('reports heard-but-unmatched speech as a failed take, not an empty one', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.nomatch());
    await finishTake(view, provider);
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('bad-audio');
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('treats an abort during finishing as a cancellation, not a failed take', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => view.handle().stop());
    // The session is already finishing when the browser aborts it outright.
    await interact(async () => {
      provider.fail('aborted', 'Speech recognition was cancelled.');
      await Promise.resolve();
    });
    // An abort is a cancellation: idle, nothing in the draft, and no error left
    // standing for the reader to dismiss.
    expect(view.handle().phase).toBe('idle');
    expect(view.drafts).toEqual([]);
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('treats an abort while recognition is still open as the same cancellation', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('half a thought'));
    // Nobody pressed Stop: the browser abandoned the session on its own, which
    // is what a second recognizer taking the microphone looks like from here.
    await interact(() => provider.fail('aborted', 'Speech recognition was cancelled.'));

    // Identical to the abort that lands during finishing — a cancelled take is
    // not a failure the reader has to read and dismiss.
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    expect(view.handle().liveText).toBe('');
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('fails closed when the browser never settles Stop', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('some words'));
    await interact(() => view.handle().stop());
    await interact(async () => {
      provider.fireTimers();
      await Promise.resolve();
    });
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('recognition-failed');
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('keeps both cycles when a mobile engine ends the first one by itself', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('first phrase'));
    await interact(() => provider.end());
    expect(view.handle().phase).toBe('recording');
    expect(provider.recognition.starts).toBe(2);

    await interact(() => provider.begin());
    await interact(() => provider.speak('second phrase'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toBe('first phrase second phrase');
    await view.unmount();
  });

  it('ignores a stop when nothing is running', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await interact(() => view.handle().stop());
    expect(view.handle().phase).toBe('idle');
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('ignores a second start while recognition is already open', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await interact(() => view.handle().start());
    await interact(() => view.handle().start());
    await interact(() => provider.begin());
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('recording');
    expect(provider.created).toBe(1);
    await view.unmount();
  });

  it('returns to idle when the tab goes to the background', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('abandoned words'));
    await interact(() => provider.hide());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().liveText).toBe('');
    expect(provider.recognition.aborts).toBe(1);

    // The abandoned take must not be able to reach the draft afterwards.
    await interact(() => view.handle().stop());
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('throws the take away on cancel', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('never mind'));
    await interact(() => view.handle().cancel());
    expect(view.handle().phase).toBe('idle');
    expect(view.drafts).toEqual([]);
    expect(provider.recognition.aborts).toBe(1);
    await view.unmount();
  });

  it('finishes exactly once when the duration ceiling and Stop race', async () => {
    const provider = fakeRecognitionProvider({ endsOnStop: true });
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await interact(() => provider.speak('a long take'));
    // The ceiling finishes the take itself; the reader presses Stop anyway.
    await interact(async () => {
      provider.fireTimers();
      await Promise.resolve();
    });
    await interact(() => view.handle().stop());
    expect(view.drafts).toHaveLength(1);
    await view.unmount();
  });

  it('refuses to record while dictation is switched off, and releases the engine', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await view.render({ settings: settingsWith({ enabled: false }) });
    expect(view.handle().phase).toBe('idle');
    expect(provider.recognition.aborts).toBe(1);

    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('idle');
    expect(provider.created).toBe(1);
    await view.unmount();
  });

  it('refuses to record while the host has disabled the control', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, disabled: true });
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('idle');
    expect(provider.created).toBe(0);
    await view.unmount();
  });

  it('releases the browser microphone on unmount', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await view.unmount();
    expect(provider.recognition.aborts).toBe(1);
  });

  it('detects the ambient browser when no provider is injected', async () => {
    // happy-dom exposes no SpeechRecognition, so ambient detection must refuse
    // rather than throw on a constructor that is not there.
    const view = await harness();
    expect(view.handle().supported).toBe(false);
    await view.unmount();
  });
});

describe('useDictation enhancement', () => {
  const dictionary = ['ferretry = ferretree, ferretry'];

  it('corrects a misheard term through the in-browser enhancer', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, settings: settingsWith({ dictionary }) });
    await record(view, provider);
    await interact(() => provider.speak('ferretree is running'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toContain('ferretry');
    await view.unmount();
  });

  it('keeps the raw words when correction is switched off', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ dictionary, enhancement: false }),
    });
    await record(view, provider);
    await interact(() => provider.speak('ferretree is running'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toBe('ferretree is running');
    await view.unmount();
  });

  it('mines recent conversation from THIS daemon-s session, under a budget', async () => {
    const provider = fakeRecognitionProvider();
    const asked: Array<[string, number | undefined, number | undefined]> = [];
    const view = await harness({
      recognition: provider,
      sessionId: 'session-1',
      settings: settingsWith({ dictionary }),
      api: {
        history: async (id, after, limit) => {
          asked.push([id, after, limit]);
          return [];
        },
      },
    });
    await record(view, provider);
    await interact(() => provider.speak('ferretree is running'));
    await finishTake(view, provider);
    expect(asked).toEqual([['session-1', undefined, CONTEXT_FETCH_LIMIT]]);
    expect(view.drafts[0]?.text).toContain('ferretry');
    await view.unmount();
  });

  it('keeps the transcript when the history read fails outright', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      sessionId: 'session-1',
      api: {
        history: async () => {
          throw new Error('daemon is down');
        },
      },
    });
    await record(view, provider);
    await interact(() => provider.speak('plain words'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toBe('plain words');
    await view.unmount();
  });

  it('adds the raw words but reports a Groq failure afterwards', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ code: 'rate_limited', error: 'Slow down.' }), { status: 429 }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);
    // The recognised words are never the price of a failed correction.
    expect(view.drafts[0]?.text).toBe('raw words');
    expect(view.drafts[0]?.enhancementError?.code).toBe('enhancement-rate-limit');
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('enhancement-rate-limit');
    await view.unmount();
  });

  it('uses the Groq answer when the daemon returns one', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ text: 'Raw words.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);
    expect(view.drafts[0]?.text).toBe('Raw words.');
    expect(view.drafts[0]?.enhancementError).toBeUndefined();
    await view.unmount();
  });
});

describe('useDictation over a relay-only daemon', () => {
  it('sends the Groq correction through the carrier router when no fetch is handed in', async () => {
    // Arrange: the direct network throws, as it does for a daemon only the relay reaches. Nothing in
    // production ever handed in `enhancementFetch`, so every correction used to take this path.
    const originalFetch = globalThis.fetch;
    const direct: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      direct.push(String(input));
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const carried: string[] = [];
    const provider = fakeRecognitionProvider();
    try {
      const view = await harness(
        { recognition: provider, settings: settingsWith({ enhancementProvider: 'groq' }) },
        async input => {
          carried.push(new URL(String(input)).pathname);
          return Response.json({ text: 'Relayed words.' });
        },
      );

      // Act
      await record(view, provider);
      await interact(() => provider.speak('relayed words'));
      await finishTake(view, provider);

      // Assert
      expect(view.drafts[0]?.text).toBe('Relayed words.');
      expect(view.drafts[0]?.enhancementError).toBeUndefined();
      expect(carried).toHaveLength(1);
      expect(direct).toEqual([]);
      await view.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * The on-device engine through the same hook. The voice service is a fake: what matters here is that
 * the hook routes to the engine the person chose, and never to the other one.
 */
describe('useDictation with the engine the person chose', () => {
  interface FakeSession {
    options: ParakeetSessionOptions;
    started: number;
    resolve(text: string): void;
    reject(error: unknown): void;
  }

  const fakeVoice = (available = true) => {
    const sessions: FakeSession[] = [];
    const voice = {
      support: available ? { available: true } : { available: false, reason: 'No WebAssembly here.' },
      createSession(options: ParakeetSessionOptions) {
        let settle: { resolve(text: string): void; reject(error: unknown): void } = {
          resolve: () => undefined,
          reject: () => undefined,
        };
        const finished = new Promise<string>((resolve, reject) => {
          settle = { resolve, reject };
        });
        finished.catch(() => undefined);
        const session: FakeSession = {
          options,
          started: 0,
          resolve: text => settle.resolve(text),
          reject: error => settle.reject(error),
        };
        sessions.push(session);
        return {
          start: () => {
            session.started += 1;
          },
          finish: () => finished,
          cancel: () => undefined,
        };
      },
    };
    return { voice: voice as unknown as ParakeetVoice, sessions };
  };

  it('asks the person to choose before any engine opens a microphone', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, settings: settingsWith({ engine: null }) });
    expect(view.handle().supported).toBe(true);
    expect(view.handle().engine).toBeNull();

    await interact(() => view.handle().start());
    expect(view.handle().error?.code).toBe('engine-not-chosen');
    expect(view.handle().error?.message).toContain('Settings › Voice');
    expect(provider.created).toBe(0);
    await view.unmount();
  });

  it('dictates through Parakeet, never the browser, when Parakeet is chosen', async () => {
    const provider = fakeRecognitionProvider();
    const { voice, sessions } = fakeVoice();
    const view = await harness({
      recognition: provider,
      parakeet: voice,
      settings: settingsWith({ engine: 'parakeet' }),
    });
    expect(view.handle().supported).toBe(true);
    expect(view.handle().engine).toBe('parakeet');

    await interact(() => view.handle().start());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.started).toBe(1);
    expect(provider.created).toBe(0);

    await interact(() => sessions[0]?.options.onStart());
    expect(view.handle().phase).toBe('recording');
    await interact(() => view.handle().stop());
    await interact(async () => {
      sessions[0]?.resolve('words from this device');
      await Promise.resolve();
    });
    expect(view.drafts.map(draft => draft.text)).toEqual(['words from this device']);
    await view.unmount();
  });

  it('shows Parakeet’s near-live words, then replaces them with the final text on Stop', async () => {
    const { voice, sessions } = fakeVoice();
    const view = await harness({
      parakeet: voice,
      settings: settingsWith({ engine: 'parakeet', liveWordsOptIn: true }),
    });
    await interact(() => view.handle().start());
    const session = sessions[0] as FakeSession;
    expect(session.options.liveWords).toBe(true);
    await interact(() => session.options.onStart());
    await interact(() => session.options.onLive?.({ committed: 'the quick', interim: 'brow', paused: false }));
    expect(view.handle().liveText).toBe('the quick brow');
    expect(view.handle().liveInterim).toBe('brow');
    expect(view.handle().livePaused).toBe(false);
    await interact(() => session.options.onLive?.({ committed: 'the quick', interim: '', paused: true }));
    expect(view.handle().liveText).toBe('the quick');
    expect(view.handle().liveInterim).toBe('');
    expect(view.handle().livePaused).toBe(true);

    await interact(() => view.handle().stop());
    // The preview stays while the final pass runs…
    expect(view.handle().liveText).toBe('the quick');
    await interact(async () => {
      session.resolve('the quick brown fox');
      await Promise.resolve();
    });
    // …and the final text, not the interim words, is what lands.
    expect(view.drafts.map(draft => draft.text)).toEqual(['the quick brown fox']);
    expect(view.handle().liveText).toBe('');
    expect(view.handle().livePaused).toBe(false);
    await view.unmount();
  });

  it('keeps Live words off by default, and ignores words from a cancelled take', async () => {
    const { voice, sessions } = fakeVoice();
    const view = await harness({ parakeet: voice, settings: settingsWith({ engine: 'parakeet' }) });
    await interact(() => view.handle().start());
    const session = sessions[0] as FakeSession;
    expect(DEFAULT_STT_SETTINGS.liveWordsOptIn).toBe(false);
    expect(session.options.liveWords).toBe(false);
    await interact(() => view.handle().cancel());
    await interact(() => session.options.onLive?.({ committed: 'late', interim: '', paused: false }));
    expect(view.handle().liveText).toBe('');
    await view.unmount();
  });

  it('reports Parakeet unsupported from its own reason', async () => {
    const { voice } = fakeVoice(false);
    const view = await harness({ parakeet: voice, settings: settingsWith({ engine: 'parakeet' }) });
    expect(view.handle().supported).toBe(false);
    await view.unmount();
  });

  it('names a missing Parakeet service instead of falling back to the browser', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      parakeet: null,
      settings: settingsWith({ engine: 'parakeet' }),
    });
    expect(view.handle().supported).toBe(false);
    await interact(() => view.handle().start());
    expect(view.handle().error).toEqual({
      code: 'recognition-unavailable',
      message: 'Parakeet is not available in this copy of Ferretry.',
    });
    expect(provider.created).toBe(0);
    await view.unmount();
  });

  it('shows a refusal the session raises before the microphone opens', async () => {
    const voice = {
      support: { available: true },
      createSession: () => {
        throw new BrowserRecognitionError('model-not-installed', 'Parakeet is not installed on this device yet.');
      },
    } as unknown as ParakeetVoice;
    const view = await harness({ parakeet: voice, settings: settingsWith({ engine: 'parakeet' }) });
    await interact(() => view.handle().start());
    expect(view.handle().error).toEqual({
      code: 'model-not-installed',
      message: 'Parakeet is not installed on this device yet.',
    });
    await view.unmount();
  });
});

/**
 * The input meter, for both engines. Parakeet hands the hook the tap on its own recording; browser
 * speech owns its microphone, so the hook opens a meter-only stream beside it and must release it
 * on every way out.
 */
describe('useDictation — the input meter', () => {
  const monitor: CaptureMonitor = { createAnalyser: () => null };

  const fakeMeter = () => {
    const state = { opened: 0, released: 0, outcome: 'open' as 'open' | 'null' | 'reject' };
    let waiting: ((meter: MicMeter | null) => void) | null = null;
    const meter: MicMeter = { monitor, release: () => (state.released += 1) };
    const port: MicMeterPort = {
      open: () => {
        state.opened += 1;
        if (state.outcome === 'reject') return Promise.reject(new Error('blocked'));
        if (state.outcome === 'null') return Promise.resolve(null);
        return new Promise(resolve => {
          waiting = resolve;
        });
      },
    };
    return { port, state, grant: () => waiting?.(meter) };
  };

  it('opens no meter and shows no tap before recording starts', async () => {
    const provider = fakeRecognitionProvider();
    const meter = fakeMeter();
    const view = await harness({ recognition: provider, meter: meter.port });
    await interact(() => view.handle().start());
    expect(meter.state.opened).toBe(0);
    expect(view.handle().inputMonitor).toBeNull();
    await view.unmount();
  });

  it('gives browser voice a meter once the engine is live, and closes it on Stop', async () => {
    const provider = fakeRecognitionProvider();
    const meter = fakeMeter();
    const view = await harness({ recognition: provider, meter: meter.port });
    await record(view, provider);
    expect(meter.state.opened).toBe(1);
    await interact(async () => {
      meter.grant();
      await Promise.resolve();
    });
    expect(view.handle().inputMonitor).toBe(monitor);

    await interact(() => view.handle().stop());
    expect(meter.state.released).toBe(1);
    expect(view.handle().inputMonitor).toBeNull();
    await view.unmount();
  });

  it('opens one meter per take even when the engine restarts and reports start again', async () => {
    const provider = fakeRecognitionProvider();
    const meter = fakeMeter();
    const view = await harness({ recognition: provider, meter: meter.port });
    await record(view, provider);
    await interact(() => provider.begin());
    await interact(() => provider.begin());
    expect(meter.state.opened).toBe(1);
    await view.unmount();
  });

  it('releases a meter that finishes opening after the take was cancelled', async () => {
    const provider = fakeRecognitionProvider();
    const meter = fakeMeter();
    const view = await harness({ recognition: provider, meter: meter.port });
    await record(view, provider);
    await interact(() => view.handle().cancel());
    await interact(async () => {
      meter.grant();
      await Promise.resolve();
    });
    expect(meter.state.released).toBe(1);
    expect(view.handle().inputMonitor).toBeNull();
    await view.unmount();
  });

  it('closes the meter when the take fails, and on unmount', async () => {
    const provider = fakeRecognitionProvider();
    const meter = fakeMeter();
    const view = await harness({ recognition: provider, meter: meter.port });
    await record(view, provider);
    await interact(async () => {
      meter.grant();
      await Promise.resolve();
    });
    await interact(() => provider.fail('not-allowed', 'blocked'));
    expect(meter.state.released).toBe(1);
    expect(view.handle().inputMonitor).toBeNull();

    const again = fakeMeter();
    const second = await harness({ recognition: provider, meter: again.port });
    await record(second, provider);
    await interact(async () => {
      again.grant();
      await Promise.resolve();
    });
    await second.unmount();
    expect(again.state.released).toBe(1);
    await view.unmount();
  });

  it('records all the same when the meter cannot open, whichever way it fails', async () => {
    for (const outcome of ['null', 'reject'] as const) {
      const provider = fakeRecognitionProvider();
      const meter = fakeMeter();
      meter.state.outcome = outcome;
      const view = await harness({ recognition: provider, meter: meter.port });
      await record(view, provider);
      await interact(async () => {
        await Promise.resolve();
      });
      expect(view.handle().phase).toBe('recording');
      expect(view.handle().inputMonitor).toBeNull();
      await view.unmount();
    }
  });

  it('opens no meter for browser voice when the page offers none', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, meter: null });
    await record(view, provider);
    expect(view.handle().phase).toBe('recording');
    expect(view.handle().inputMonitor).toBeNull();
    await view.unmount();
  });

  it('takes Parakeet’s tap from the session and never opens a second microphone', async () => {
    const meter = fakeMeter();
    const created: { options: ParakeetSessionOptions }[] = [];
    const voice = {
      support: { available: true },
      createSession: (options: ParakeetSessionOptions) => {
        created.push({ options });
        return { start: () => undefined, finish: () => new Promise<string>(() => undefined), cancel: () => undefined };
      },
    } as unknown as ParakeetVoice;
    const view = await harness({
      parakeet: voice,
      meter: meter.port,
      settings: settingsWith({ engine: 'parakeet' }),
    });
    await interact(() => view.handle().start());
    const options = (created[0] as { options: ParakeetSessionOptions }).options;
    await interact(() => options.onStart());
    await interact(() => options.onMonitor?.(monitor));
    expect(view.handle().inputMonitor).toBe(monitor);
    expect(meter.state.opened).toBe(0);

    await interact(() => options.onMonitor?.(null));
    expect(view.handle().inputMonitor).toBeNull();
    await interact(() => view.handle().cancel());
    await interact(() => options.onMonitor?.(monitor));
    expect(view.handle().inputMonitor).toBeNull();
    await view.unmount();
  });
});
