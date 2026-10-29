import { describe, expect, it } from 'bun:test';
import { type FyEvent, peerEnvelopePreamble, turnFileInstruction } from '@ferretry/protocol';
import type { ReactElement } from 'react';
import {
  CONTEXT_FETCH_LIMIT,
  conversationFromTranscript,
  type DictationAutoInsertion,
  type DictationDraftResult,
  type DictationHandle,
  enhancementErrorFrom,
  extractContextMessages,
  extractHeldMessages,
  hasUsableContext,
  noCleanupKeyMessage,
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
import { DICTATION_DEBUG_KEY, DictationDebugLog } from '../../src/lib/stt/dictation-debug.ts';
import { DeviceSpeedupKeys } from '../../src/lib/stt/speedup-keys.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import { TRANSCRIPTION_LOG_KEY, TranscriptionLog } from '../../src/lib/stt/transcription-log.ts';
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

/** Stop, settle, then press Insert on whatever the take produced (an empty take has nothing to insert). */
const landTake = async (view: Harness, provider: FakeRecognitionProvider): Promise<void> => {
  await finishTake(view, provider);
  const review = view.handle().review;
  if (review !== null) await interact(() => view.handle().insert(review.cleaned));
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

  it("drops Ferretry plumbing from the person's side and keeps a peer message's body", () => {
    const peer = peerEnvelopePreamble({ name: 'kite', sessionId: 's-1', kind: 'message', clientName: 'fy' });
    expect(
      extractContextMessages([
        event('chat.user', turnFileInstruction('/home/x/.fy/s/turns/turn-001.md')),
        event('chat.user', '[ferretry] your message did not arrive'),
        event('chat.user', `${peer}the schema change landed`),
        event('chat.user', '<pasted_content id="1">\nplease review the diff\n</pasted_content>'),
      ]),
    ).toEqual(['the schema change landed', 'please review the diff']);
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

    await landTake(view, provider);
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
    await landTake(view, provider);
    expect(view.drafts[0]?.text).toBe('start hello world end');
    await view.unmount();
  });

  it('says nothing at all about a mis-tap that captured no speech', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider });
    await record(view, provider);
    await landTake(view, provider);
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
    await landTake(view, provider);
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
    await landTake(view, provider);
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
    // One take, one review: the second finish found nothing left to claim.
    expect(view.handle().phase).toBe('review');
    expect(view.handle().review?.id).toBe(1);
    expect(view.drafts).toEqual([]);
    await interact(() => view.handle().insert('a long take'));
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
    await landTake(view, provider);
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
    await landTake(view, provider);
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
    await landTake(view, provider);
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
    await landTake(view, provider);
    expect(view.drafts[0]?.text).toBe('plain words');
    await view.unmount();
  });

  it('reviews the raw words and says why when a Groq cleanup fails', async () => {
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
    // The recognised words are never the price of a failed correction — and they wait for Insert.
    expect(view.drafts).toEqual([]);
    expect(view.handle().phase).toBe('review');
    expect(view.handle().review?.cleaned).toBe('raw words');
    expect(view.handle().review?.enhancementError?.code).toBe('enhancement-rate-limit');
    expect(view.handle().error).toBeNull();
    await interact(() => view.handle().insert('raw words'));
    expect(view.drafts[0]?.text).toBe('raw words');
    await view.unmount();
  });

  it('says why when the daemon kept the raw words because the reply failed its guard', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(
          JSON.stringify({
            text: 'raw words',
            kept: 'raw',
            keptReason: 'The cleanup reply pulled in words from the conversation.',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);
    expect(view.handle().review?.cleaned).toBe('raw words');
    expect(view.handle().review?.enhancementError).toEqual({
      code: 'enhancement-kept-raw',
      message: 'The cleanup reply pulled in words from the conversation.',
    });
    await view.unmount();
  });

  it('falls back to a generic reason when a kept reply carries none', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ text: 'raw words', kept: 'raw' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);
    expect(view.handle().review?.enhancementError?.message).toMatch(/did not read as your words corrected/u);
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
    await landTake(view, provider);
    expect(view.drafts[0]?.text).toBe('Raw words.');
    await view.unmount();
  });
});

describe('useDictation review', () => {
  const reviewed = async (draft = ''): Promise<{ view: Harness; provider: FakeRecognitionProvider }> => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, draft });
    await record(view, provider);
    await interact(() => provider.speak('hello world'));
    await finishTake(view, provider);
    return { view, provider };
  };

  it('parks the take for review: nothing reaches the draft on Stop', async () => {
    const { view } = await reviewed();
    expect(view.handle().phase).toBe('review');
    expect(view.handle().review).toEqual({ id: 1, raw: 'hello world', cleaned: 'hello world' });
    expect(view.handle().busy).toBe(false);
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('inserts the edited text once, at the caret as it is at that moment', async () => {
    const { view } = await reviewed('start end');
    // The reader kept typing in the composer while the box was open.
    await view.render({
      draft: 'start typed end',
      selectionRef: { current: { selectionStart: 11, selectionEnd: 11 } },
    });
    await interact(() => view.handle().insert('hello, world'));
    expect(view.drafts).toEqual([{ text: 'start typed hello, world end', caret: 24 }]);
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().review).toBeNull();

    // A second Insert has no review to act on.
    await interact(() => view.handle().insert('again'));
    expect(view.drafts).toHaveLength(1);
    await view.unmount();
  });

  it('closes without touching the draft when the person emptied the text', async () => {
    const { view } = await reviewed();
    await interact(() => view.handle().insert('   '));
    expect(view.drafts).toEqual([]);
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('ignores Insert outside a review', async () => {
    const view = await harness();
    await interact(() => view.handle().insert('stray'));
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('discards a review without touching the draft', async () => {
    const { view } = await reviewed();
    await interact(() => view.handle().discard());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().review).toBeNull();
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('starting again replaces the review, and the next take gets a new id', async () => {
    const { view, provider } = await reviewed();
    await interact(() => view.handle().start());
    expect(view.handle().review).toBeNull();
    await interact(() => provider.begin());
    await interact(() => provider.speak('second take'));
    await finishTake(view, provider);
    expect(view.handle().review).toEqual({ id: 2, raw: 'second take', cleaned: 'second take' });
    await view.unmount();
  });

  it('drops a review when dictation is switched off', async () => {
    const { view } = await reviewed();
    await view.render({ settings: settingsWith({ enabled: false }) });
    expect(view.handle().review).toBeNull();
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });
});

describe('useDictation insert straight away', () => {
  const insertMode = settingsWith({ afterDictation: 'insert' });

  const dictate = async (
    initial: Partial<UseDictationOptions> = {},
  ): Promise<{ view: Harness; provider: FakeRecognitionProvider; inserted: DictationAutoInsertion[] }> => {
    const provider = fakeRecognitionProvider();
    const inserted: DictationAutoInsertion[] = [];
    const view = await harness({
      recognition: provider,
      settings: insertMode,
      onAutoInserted: insertion => inserted.push(insertion),
      ...initial,
    });
    await record(view, provider);
    return { view, provider, inserted };
  };

  it('puts a clean take in the draft exactly once, with no review, and says what it replaced', async () => {
    const { view, provider, inserted } = await dictate({ draft: 'typed' });
    await interact(() => provider.speak('hello world'));
    await finishTake(view, provider);

    expect(view.drafts).toEqual([{ text: 'typed hello world', caret: 17 }]);
    expect(inserted).toEqual([
      { before: { text: 'typed', caret: 5 }, after: { text: 'typed hello world', caret: 17 } },
    ]);
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().review).toBeNull();
    // Nothing later re-inserts it.
    await interact(() => view.handle().insert('hello world'));
    expect(view.drafts).toHaveLength(1);
    await view.unmount();
  });

  it('uses the same caret rules as Insert: at the live caret, replacing a selection', async () => {
    const selectionRef = { current: { selectionStart: 6, selectionEnd: 9 } };
    const { view, provider, inserted } = await dictate({ draft: 'start end', selectionRef });
    await interact(() => provider.speak('hello'));
    await finishTake(view, provider);

    expect(view.drafts[0]?.text).toBe('start hello');
    expect(inserted[0]?.before).toEqual({ text: 'start end', caret: 6 });
    await view.unmount();
  });

  it('never calls onAutoInserted when the person reviews first', async () => {
    const { view, provider, inserted } = await dictate({ settings: settingsWith({ afterDictation: 'review' }) });
    await interact(() => provider.speak('hello world'));
    await finishTake(view, provider);

    expect(view.handle().phase).toBe('review');
    expect(view.drafts).toEqual([]);
    expect(inserted).toEqual([]);
    await interact(() => view.handle().insert('hello world'));
    expect(view.drafts).toHaveLength(1);
    expect(inserted).toEqual([]);
    await view.unmount();
  });

  it('still parks the take for review, with the reason, when clean-up fails', async () => {
    const { view, provider, inserted } = await dictate({
      settings: settingsWith({ afterDictation: 'insert', enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ code: 'rate_limited', error: 'Slow down.' }), { status: 429 }),
    });
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);

    expect(view.drafts).toEqual([]);
    expect(inserted).toEqual([]);
    expect(view.handle().phase).toBe('review');
    expect(view.handle().review?.cleaned).toBe('raw words');
    expect(view.handle().review?.enhancementError?.code).toBe('enhancement-rate-limit');
    await view.unmount();
  });

  it('inserts nothing for a take that captured no speech', async () => {
    const { view, provider, inserted } = await dictate();
    await finishTake(view, provider);

    expect(view.drafts).toEqual([]);
    expect(inserted).toEqual([]);
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('shows a recognition failure as an error rather than inserting anything', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({ recognition: provider, settings: insertMode });
    await record(view, provider);
    await interact(() => provider.fail('not-allowed'));

    expect(view.drafts).toEqual([]);
    expect(view.handle().phase).toBe('error');
    await view.unmount();
  });

  it('follows the setting as it changes between takes', async () => {
    const { view, provider } = await dictate();
    await interact(() => provider.speak('first'));
    await finishTake(view, provider);
    expect(view.drafts.map(draft => draft.text)).toEqual(['first']);

    await view.render({ settings: settingsWith({ afterDictation: 'review' }), draft: 'first' });
    await interact(() => view.handle().start());
    await interact(() => provider.begin());
    await interact(() => provider.speak('second'));
    await finishTake(view, provider);
    expect(view.handle().phase).toBe('review');
    expect(view.drafts).toHaveLength(1);
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
      await landTake(view, provider);

      // Assert
      expect(view.drafts[0]?.text).toBe('Relayed words.');
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
    expect(view.handle().review?.cleaned).toBe('words from this device');
    await interact(() => view.handle().insert('words from this device'));
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
    // …and the final text, not the interim words, is what waits for Insert.
    expect(view.handle().review?.cleaned).toBe('the quick brown fox');
    expect(view.drafts).toEqual([]);
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

describe('useDictation with the machine’s cleanup settings', () => {
  const messages: FyEvent[] = Array.from(
    { length: 12 },
    (_, index) => ({ type: 'chat.user', data: { text: `message ${index + 1}` } }) as unknown as FyEvent,
  );

  /** One take through a hosted provider; resolves to what was sent (or `null` when nothing was). */
  const take = async (
    voiceCleanup: UseDictationOptions['voiceCleanup'],
    answer: () => Response = () => Response.json({ text: 'Raw words.' }),
  ): Promise<{ sent: Record<string, unknown> | null; history: number; text: string | undefined }> => {
    const provider = fakeRecognitionProvider();
    let sent: Record<string, unknown> | null = null;
    let history = 0;
    const view = await harness({
      recognition: provider,
      sessionId: 'session-1',
      api: {
        history: async () => {
          history += 1;
          return messages;
        },
      },
      settings: settingsWith({ enhancementProvider: 'groq' }),
      ...(voiceCleanup === undefined ? {} : { voiceCleanup }),
      enhancementFetch: async (_url, init) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return answer();
      },
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await landTake(view, provider);
    const text = view.drafts[0]?.text;
    await view.unmount();
    return { sent, history, text };
  };

  const cleanup = (patch: Partial<NonNullable<UseDictationOptions['voiceCleanup']>>) => ({
    style: 'fix' as const,
    prompts: {},
    useConversation: false,
    conversationMessages: 8,
    ...patch,
  });

  it('sends no conversation to a hosted provider by default, and does not even read it', async () => {
    const result = await take(undefined);
    expect(result.sent?.context).toEqual([]);
    expect(result.history).toBe(0);
  });

  it('sends the latest N messages when the machine turns the conversation on', async () => {
    const result = await take(cleanup({ useConversation: true, conversationMessages: 3 }));
    expect(result.sent?.context).toEqual(['message 10', 'message 11', 'message 12']);
  });

  it('sends everything the history read yields, up to the machine’s count', async () => {
    const result = await take(cleanup({ useConversation: true }));
    expect(result.sent?.context).toHaveLength(8);
  });

  it('sends nothing and spends nothing when the machine has cleanup off', async () => {
    const result = await take(cleanup({ style: 'off', useConversation: true }));
    expect(result.sent).toBeNull();
    expect(result.history).toBe(0);
    expect(result.text).toBe('raw words');
  });

  it('inserts the transcript as-is when the daemon kept the raw words', async () => {
    const result = await take(cleanup({}), () => Response.json({ text: 'raw words', kept: 'raw' }));
    expect(result.text).toBe('raw words');
  });

  it('leaves on-device correction on its own context rules whatever the machine says', async () => {
    const provider = fakeRecognitionProvider();
    let history = 0;
    const view = await harness({
      recognition: provider,
      sessionId: 'session-1',
      api: {
        history: async () => {
          history += 1;
          return messages;
        },
      },
      settings: settingsWith({ enhancementProvider: 'local' }),
      voiceCleanup: cleanup({ style: 'off' }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await finishTake(view, provider);
    expect(history).toBe(1);
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

/**
 * Hosted clean-up with a key THIS device holds goes straight to the provider; without one it asks the
 * daemon, and when neither has a key the words are kept with a sentence saying where to add one.
 */
describe('useDictation — clean-up with a key this device holds', () => {
  /** Real WebCrypto opens the key, which takes more than a microtask: wait for the take to settle. */
  const settled = async (view: Harness, provider: FakeRecognitionProvider): Promise<void> => {
    await finishTake(view, provider);
    for (let tries = 0; tries < 100 && view.handle().phase === 'transcribing'; tries += 1) {
      await interact(() => new Promise(resolve => setTimeout(resolve, 2)));
    }
  };
  const landed = async (view: Harness, provider: FakeRecognitionProvider): Promise<void> => {
    await settled(view, provider);
    const review = view.handle().review;
    if (review !== null) await interact(() => view.handle().insert(review.cleaned));
  };
  const deviceKeys = async (answer: () => Response, saved = true) => {
    const records = new Map<string, unknown>();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const keys = new DeviceSpeedupKeys(
      {
        get: async slot => records.get(slot),
        put: async (slot, value) => void records.set(slot, value),
        delete: async slot => void records.delete(slot),
      },
      crypto.subtle,
      async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return answer();
      },
    );
    if (saved) await keys.save('groq', 'gsk_test_0123456789abcdef');
    return { keys, calls };
  };
  const completion = (content: string) => () => Response.json({ choices: [{ message: { content } }] });

  it('cleans up straight from the browser and never asks the daemon', async () => {
    const provider = fakeRecognitionProvider();
    const { keys, calls } = await deviceKeys(completion('Raw words.'));
    let daemonCalls = 0;
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      speedupKeys: keys,
      enhancementFetch: async () => {
        daemonCalls += 1;
        return Response.json({ text: 'from the daemon' });
      },
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await landed(view, provider);
    expect(view.drafts[0]?.text).toBe('Raw words.');
    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(daemonCalls).toBe(0);
    await view.unmount();
  });

  it('reads the conversation the page already holds instead of fetching history', async () => {
    const provider = fakeRecognitionProvider();
    const { keys, calls } = await deviceKeys(completion('Raw words.'));
    let history = 0;
    const view = await harness({
      recognition: provider,
      sessionId: 'session-1',
      api: {
        history: async () => {
          history += 1;
          return [];
        },
      },
      readConversation: () => ['', 'the message the page is showing right now'],
      settings: settingsWith({ enhancementProvider: 'groq' }),
      voiceCleanup: { style: 'fix', prompts: {}, useConversation: true, conversationMessages: 8 },
      speedupKeys: keys,
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await landed(view, provider);
    const messages = calls[0]?.body.messages as { content: string }[];
    expect(messages[1]?.content).toContain('<reference>\nthe message the page is showing right now\n</reference>');
    expect(history).toBe(0);
    await view.unmount();
  });

  it('says why when the provider refuses this device’s key, and keeps the words', async () => {
    const provider = fakeRecognitionProvider();
    const { keys } = await deviceKeys(() => new Response('{}', { status: 401 }));
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      speedupKeys: keys,
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await settled(view, provider);
    expect(view.handle().review?.cleaned).toBe('raw words');
    expect(view.handle().review?.enhancementError?.code).toBe('enhancement-provider-auth');
    await view.unmount();
  });

  it('asks the daemon when this device holds no key', async () => {
    const provider = fakeRecognitionProvider();
    const { keys, calls } = await deviceKeys(completion('unused'), false);
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      speedupKeys: keys,
      enhancementFetch: async () => Response.json({ text: 'From the daemon.' }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await landed(view, provider);
    expect(view.drafts[0]?.text).toBe('From the daemon.');
    expect(calls).toHaveLength(0);
    await view.unmount();
  });

  it('says where to add a key when neither this device nor the daemon has one', async () => {
    const provider = fakeRecognitionProvider();
    const view = await harness({
      recognition: provider,
      settings: settingsWith({ enhancementProvider: 'groq' }),
      speedupKeys: null,
      enhancementFetch: async () =>
        Response.json({ code: 'secret_missing', error: 'enhancement provider is not configured' }, { status: 503 }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await settled(view, provider);
    expect(view.handle().review?.cleaned).toBe('raw words');
    expect(view.handle().review?.enhancementError).toEqual({
      code: 'enhancement-not-configured',
      message: noCleanupKeyMessage('Groq'),
    });
    expect(noCleanupKeyMessage('Groq')).toContain('add a Groq key in Settings › This device');
    await view.unmount();
  });

  describe('the debug ring and the transcription log', () => {
    const memoryStorage = (initial: Record<string, string> = {}) => {
      const values = new Map(Object.entries(initial));
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
    };
    const rig = (debugOn: boolean, logOn = true) => {
      const clock = { t: 1_000_000 };
      const rows = new Map<string, unknown>();
      const debug = new DictationDebugLog(memoryStorage({ [DICTATION_DEBUG_KEY]: debugOn ? 'on' : 'off' }));
      const issued = { count: 0 };
      const log = new TranscriptionLog(
        {
          list: async () => [...rows.values()],
          put: async entry => void rows.set(entry.id, entry),
          delete: async id => void rows.delete(id),
          clear: async () => rows.clear(),
        },
        {
          storage: memoryStorage({ [TRANSCRIPTION_LOG_KEY]: logOn ? 'on' : 'off' }),
          now: () => clock.t,
          newId: () => {
            issued.count += 1;
            return `entry-${String(issued.count)}`;
          },
        },
      );
      return { clock, debug, log };
    };
    const dictate = async (
      view: Harness,
      provider: FakeRecognitionProvider,
      clock: { t: number },
      words = 'raw words',
    ): Promise<void> => {
      await interact(() => view.handle().start());
      await interact(() => provider.begin());
      await interact(() => provider.speak(words));
      clock.t += 4_000;
      await settled(view, provider);
    };
    const options = async (
      answer: () => Response,
      debugOn: boolean,
      logOn = true,
    ): Promise<{
      options: Partial<UseDictationOptions>;
      r: ReturnType<typeof rig>;
      calls: { body: Record<string, unknown> }[];
      provider: FakeRecognitionProvider;
    }> => {
      const r = rig(debugOn, logOn);
      const { keys, calls } = await deviceKeys(answer);
      return {
        r,
        calls,
        provider: fakeRecognitionProvider(),
        options: {
          settings: settingsWith({ enhancementProvider: 'groq' }),
          voiceCleanup: { style: 'polish', prompts: {}, useConversation: false, conversationMessages: 8 },
          speedupKeys: keys,
          dictationDebug: r.debug,
          transcriptionLog: r.log,
          sessionId: 'session-1',
          sessionLabel: 'Fix the build',
          now: () => r.clock.t,
        },
      };
    };

    it('keeps one debug record for the call, without the key, and points the review and the log at it', async () => {
      const { options: base, r, provider } = await options(completion('Raw words.'), true);
      const view = await harness({ ...base, recognition: provider });
      await dictate(view, provider, r.clock);
      const id = view.handle().review?.debugId;
      expect(id).toBe('debug-1');
      expect(r.debug.snapshot().records.map(record => record.id)).toEqual(['debug-1']);
      expect(JSON.stringify(r.debug.snapshot().records)).not.toContain('gsk_test');
      expect(r.log.snapshot().entries[0]).toMatchObject({
        id: 'entry-1',
        sessionId: 'session-1',
        sessionLabel: 'Fix the build',
        engine: 'web-speech',
        durationMs: 4_000,
        raw: 'raw words',
        cleaned: 'Raw words.',
        prompt: 'polish',
        outcome: 'pending',
        debugId: 'debug-1',
      });
      await view.unmount();
    });

    it('keeps a debug record for a refused call too', async () => {
      const { options: base, r, provider } = await options(() => new Response('{}', { status: 401 }), true);
      const view = await harness({ ...base, recognition: provider });
      await dictate(view, provider, r.clock);
      expect(view.handle().review?.enhancementError?.code).toBe('enhancement-provider-auth');
      expect(view.handle().review?.debugId).toBe('debug-1');
      expect(r.log.snapshot().entries[0]?.cleaned).toBeUndefined();
      await view.unmount();
    });

    it('keeps nothing in the ring, and asks the daemon for no echo, when debug is off', async () => {
      const { options: base, r, provider } = await options(completion('Raw words.'), false);
      const bodies: Record<string, unknown>[] = [];
      const view = await harness({
        ...base,
        speedupKeys: null,
        recognition: provider,
        enhancementFetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ text: 'From the daemon.' });
        },
      });
      await dictate(view, provider, r.clock);
      expect(bodies[0]).not.toHaveProperty('debug');
      expect(view.handle().review?.debugId).toBeUndefined();
      expect(r.debug.snapshot().records).toEqual([]);
      expect(r.log.snapshot().entries[0]?.debugId).toBeUndefined();
      await view.unmount();
    });

    it('asks the daemon for its debug echo when debug is on', async () => {
      const { options: base, r, provider } = await options(completion('unused'), true);
      const bodies: Record<string, unknown>[] = [];
      const view = await harness({
        ...base,
        speedupKeys: null,
        recognition: provider,
        enhancementFetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ text: 'From the daemon.' });
        },
      });
      await dictate(view, provider, r.clock);
      expect(bodies[0]?.debug).toBe(true);
      expect(view.handle().review?.debugId).toBeUndefined();
      await view.unmount();
    });

    it('records a take without cleanup as raw words only', async () => {
      const r = rig(false);
      const provider = fakeRecognitionProvider();
      const view = await harness({
        recognition: provider,
        dictationDebug: r.debug,
        transcriptionLog: r.log,
        now: () => r.clock.t,
      });
      await dictate(view, provider, r.clock);
      const entry = r.log.snapshot().entries[0];
      expect(entry?.raw).toBe('raw words');
      expect(entry?.cleaned).toBeUndefined();
      expect(entry?.prompt).toBeUndefined();
      expect(entry?.sessionId).toBeUndefined();
      await view.unmount();
    });

    it('settles the entry as inserted, with the edited words only when they were edited', async () => {
      const { options: base, r, provider } = await options(completion('Raw words.'), false);
      const view = await harness({ ...base, recognition: provider });
      await dictate(view, provider, r.clock);
      await interact(() => view.handle().insert('Raw words.'));
      expect(r.log.snapshot().entries[0]).toMatchObject({ outcome: 'inserted' });
      expect(r.log.snapshot().entries[0]).not.toHaveProperty('inserted');
      await dictate(view, provider, r.clock, 'second take');
      await interact(() => view.handle().insert('  Edited by hand.  '));
      expect(r.log.snapshot().entries[0]).toMatchObject({ outcome: 'inserted', inserted: 'Edited by hand.' });
      await view.unmount();
    });

    describe('the timeline of a dictation', () => {
      /** Every read of the clock moves it on by 10 ms, so each measured span has a stable, non-zero length. */
      const ticking = () => {
        const reads = { at: 0 };
        return () => {
          reads.at += 10;
          return reads.at;
        };
      };

      it('records how long Stop took and how long the hosted cleanup took, for a device key', async () => {
        const { options: base, r, provider } = await options(completion('Raw words.'), false);
        const view = await harness({ ...base, monotonic: ticking(), recognition: provider });
        await dictate(view, provider, r.clock);
        const timeline = r.log.snapshot().entries[0]?.timeline;
        expect(timeline?.speech.engine).toBe('web-speech');
        expect(timeline?.speech.provider).toBe('browser');
        expect(timeline?.speech.totalMs).toBeGreaterThan(0);
        expect(timeline?.cleanup).toMatchObject({ provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1 });
        expect(timeline?.cleanup?.totalMs).toBeGreaterThan(0);
        expect(timeline?.totalMs).toBeGreaterThan(timeline?.cleanup?.totalMs ?? Number.POSITIVE_INFINITY);
        expect(timeline?.insertMs).toBeUndefined();
        await view.unmount();
      });

      it('adds the insertion time and the time in the review box when the words are inserted', async () => {
        const { options: base, r, provider } = await options(completion('Raw words.'), true);
        const view = await harness({ ...base, monotonic: ticking(), recognition: provider });
        await dictate(view, provider, r.clock);
        await interact(() => view.handle().insert('Raw words.'));
        const timeline = r.log.snapshot().entries[0]?.timeline;
        expect(timeline?.insertMs).toBeGreaterThan(0);
        expect(timeline?.reviewMs).toBeGreaterThan(0);
        expect(r.debug.snapshot().records[0]?.timeline).toEqual(timeline);
        await view.unmount();
      });

      it('times a refused call as a failed one', async () => {
        const { options: base, r, provider } = await options(() => new Response('{}', { status: 401 }), true);
        const view = await harness({ ...base, monotonic: ticking(), recognition: provider });
        await dictate(view, provider, r.clock);
        const timeline = r.log.snapshot().entries[0]?.timeline;
        expect(timeline?.cleanup).toMatchObject({ provider: 'groq', via: 'device', outcome: 'failed' });
        expect(timeline?.cleanup?.totalMs).toBeGreaterThan(0);
        await view.unmount();
      });

      it('times the daemon path and keeps the provider time it reported', async () => {
        const { options: base, r, provider } = await options(completion('unused'), false);
        const view = await harness({
          ...base,
          speedupKeys: null,
          monotonic: ticking(),
          recognition: provider,
          enhancementFetch: async () => Response.json({ text: 'From the daemon.', latencyMs: 410 }),
        });
        await dictate(view, provider, r.clock);
        const timeline = r.log.snapshot().entries[0]?.timeline;
        expect(timeline?.cleanup).toMatchObject({ via: 'daemon', outcome: 'cleaned', providerMs: 410 });
        await view.unmount();
      });

      it('times the on-device correction when no hosted cleanup is configured', async () => {
        const r = rig(false);
        const provider = fakeRecognitionProvider();
        const view = await harness({
          recognition: provider,
          monotonic: ticking(),
          dictationDebug: r.debug,
          transcriptionLog: r.log,
          now: () => r.clock.t,
        });
        await dictate(view, provider, r.clock);
        const timeline = r.log.snapshot().entries[0]?.timeline;
        expect(timeline?.speech.engine).toBe('web-speech');
        expect(timeline?.cleanup).toMatchObject({ provider: 'local', via: 'local' });
        await view.unmount();
      });
    });

    it('settles the entry as discarded on cancel, on a new start and when dictation is switched off', async () => {
      const { options: base, r, provider } = await options(completion('Raw words.'), false);
      const view = await harness({ ...base, recognition: provider });
      await dictate(view, provider, r.clock);
      await interact(() => view.handle().cancel());
      expect(r.log.snapshot().entries[0]?.outcome).toBe('discarded');
      await dictate(view, provider, r.clock, 'again');
      await interact(() => view.handle().start());
      expect(r.log.snapshot().entries[0]?.outcome).toBe('discarded');
      await interact(() => view.handle().cancel());
      await dictate(view, provider, r.clock, 'third');
      await view.render({ ...base, disabled: true, recognition: provider });
      expect(r.log.snapshot().entries[0]?.outcome).toBe('discarded');
      await view.unmount();
    });

    it('keeps no entry when the log is off, and works with neither the log nor the ring', async () => {
      const off = await options(completion('Raw words.'), true, false);
      const view = await harness({ ...off.options, recognition: off.provider });
      await dictate(view, off.provider, off.r.clock);
      expect(off.r.log.snapshot().entries).toEqual([]);
      await interact(() => view.handle().insert('Raw words.'));
      await view.unmount();

      const none = await options(completion('Raw words.'), true);
      const bare = await harness({
        ...none.options,
        dictationDebug: null,
        transcriptionLog: null,
        recognition: none.provider,
      });
      await dictate(bare, none.provider, none.r.clock);
      expect(bare.handle().review?.cleaned).toBe('Raw words.');
      expect(bare.handle().review?.debugId).toBeUndefined();
      await interact(() => bare.handle().insert('Raw words.'));
      await bare.unmount();
    });
  });
});

describe('the conversation a page holds', () => {
  it('keeps what was said and drops tool rows, notices and hand-off pointers', () => {
    expect(
      conversationFromTranscript([
        { kind: 'user', text: 'first' },
        { kind: 'tool', text: 'rm -rf' },
        { kind: 'user', text: 'see the turn file', handoff: { path: '/x' } },
        { kind: 'notice', text: 'delivered' },
        { kind: 'assistant', text: 'second' },
      ]),
    ).toEqual(['first', 'second']);
  });

  it('keeps the newest ten non-empty messages', () => {
    const many = Array.from({ length: 14 }, (_, index) => `message ${index + 1}`);
    expect(extractHeldMessages(['  ', ...many])).toEqual(many.slice(-10));
  });

  it('asks for enough of it before on-device correction treats it as evidence', async () => {
    const provider = fakeRecognitionProvider();
    let reads = 0;
    const view = await harness({
      recognition: provider,
      readConversation: () => {
        reads += 1;
        return ['only one message'];
      },
      settings: settingsWith({ enhancementProvider: 'local' }),
    });
    await record(view, provider);
    await interact(() => provider.speak('raw words'));
    await landTake(view, provider);
    expect(reads).toBe(1);
    expect(view.drafts[0]?.text).toBe('raw words');
    await view.unmount();
  });
});
