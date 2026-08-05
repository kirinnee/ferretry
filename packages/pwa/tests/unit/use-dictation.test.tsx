import { describe, expect, it } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
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
import { RemoteEnhancementError } from '../../src/lib/stt/remote-enhancement.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import {
  type FakeRecognitionProvider,
  fakeRecognitionProvider,
  UNSUPPORTED_RECOGNITION,
  unsupportedRecognitionProvider,
} from '../support/browser-recognition.ts';
import { interact, mount } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceToken: 'token-a' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...patch });

interface Harness {
  handle(): DictationHandle;
  drafts: DictationDraftResult[];
  render(next: Partial<UseDictationOptions>): Promise<void>;
  unmount(): Promise<void>;
}

/** Mounts the hook and exposes the live handle plus every draft it produced. */
const harness = async (initial: Partial<UseDictationOptions> = {}): Promise<Harness> => {
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

  const view = await mount(<Probe {...propsFor({})} />);
  return {
    handle: () => {
      if (latest.handle === null) throw new Error('the hook did not run');
      return latest.handle;
    },
    drafts,
    render: async next => view.render(<Probe {...propsFor(next)} />),
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
