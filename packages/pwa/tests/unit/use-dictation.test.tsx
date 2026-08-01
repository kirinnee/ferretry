import { describe, expect, it } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
import {
  CONTEXT_FETCH_LIMIT,
  type DictationDraftResult,
  type DictationEngine,
  type DictationHandle,
  daemonDictationEngine,
  enhancementErrorFrom,
  extractContextMessages,
  hasUsableContext,
  useDictation,
  type UseDictationOptions,
  withinContextFetchBudget,
} from '../../src/hooks/use-dictation.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import type { CaptureGraph, CaptureHost, MicrophoneStream } from '../../src/lib/stt/audio-capture.ts';
import { CaptureError } from '../../src/lib/stt/capture-error.ts';
import { SttRequestError } from '../../src/lib/stt/daemon-engine.ts';
import { MAX_UTTERANCE_SECONDS, TARGET_SAMPLE_RATE } from '../../src/lib/stt/pcm.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../src/lib/stt/stt-settings.ts';
import { interact, mount } from '../support/dom.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceToken: 'token-a' });
const other = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'http://127.0.0.1:2', deviceToken: 'token-b' });

const settingsWith = (patch: Partial<SttSettings> = {}): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...patch });

/** Enough audio to clear the minimum-utterance floor. */
const speech = (seconds = 1): Float32Array => new Float32Array(Math.round(TARGET_SAMPLE_RATE * seconds)).fill(0.2);

interface FakeHost {
  readonly host: CaptureHost;
  /** Resolve the pending permission prompt. */
  openMic(): void;
  /** Reject it, the way a blocked site does. */
  denyMic(error: unknown): void;
  /** Deliver a batch of samples the way a worklet would. */
  emit(samples: Float32Array): void;
  /** The tab went to the background. */
  hide(): void;
  released(): number;
}

const fakeCaptureHost = (): FakeHost => {
  let resolveMic: ((stream: MicrophoneStream) => void) | null = null;
  let rejectMic: ((error: unknown) => void) | null = null;
  const microphone = new Promise<MicrophoneStream>((resolve, reject) => {
    resolveMic = resolve;
    rejectMic = reject;
  });
  const state: { sink: ((samples: Float32Array) => void) | null; hidden: (() => void) | null; released: number } = {
    sink: null,
    hidden: null,
    released: 0,
  };
  const graph: CaptureGraph = {
    inputSampleRate: TARGET_SAMPLE_RATE,
    flush: async () => undefined,
    createAnalyser: () => null,
    release: () => {
      state.released += 1;
    },
  };
  const host: CaptureHost = {
    openMicrophone: () => microphone,
    buildGraph: async (_microphone, sink) => {
      state.sink = sink;
      return graph;
    },
    watchHidden: onHidden => {
      state.hidden = onHidden;
      return () => {
        state.hidden = null;
      };
    },
  };
  return {
    host,
    openMic: () => resolveMic?.({ stream: { id: 'stream' } }),
    denyMic: error => rejectMic?.(error),
    emit: samples => state.sink?.(samples),
    hide: () => state.hidden?.(),
    released: () => state.released,
  };
};

const staticEngine = (text: string): DictationEngine => ({ transcribe: async () => text });
const failingEngine = (failure: unknown): DictationEngine => ({
  transcribe: async () => {
    throw failure;
  },
});

interface Harness {
  handle(): DictationHandle;
  drafts: DictationDraftResult[];
  render(next: Partial<UseDictationOptions>): Promise<void>;
  unmount(): Promise<void>;
}

/** Mounts the hook and exposes the live handle plus every draft it produced. */
const harness = async (
  initial: Partial<UseDictationOptions> & { captureHost: CaptureHost | null },
): Promise<Harness> => {
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
    engine: staticEngine('hello world'),
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

/** Open the microphone and reach `recording`. */
const record = async (view: Harness, mic: FakeHost): Promise<void> => {
  await interact(() => view.handle().start());
  await interact(() => mic.openMic());
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
    expect(enhancementErrorFrom(new SttRequestError('busy', 'later'))).toEqual({
      code: 'enhancement-busy',
      message: 'later',
    });
  });

  it('falls back for a codeless or non-error failure', () => {
    expect(enhancementErrorFrom(new Error('boom'))).toEqual({ code: 'enhancement-provider', message: 'boom' });
    expect(enhancementErrorFrom('nope').code).toBe('enhancement-provider');
    expect(enhancementErrorFrom('nope').message).toContain('raw dictation was kept');
  });
});

describe('daemonDictationEngine', () => {
  const okResponse = (text: string): Response =>
    new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('posts the utterance to the named daemon and returns its words', async () => {
    const seen: string[] = [];
    const engine = daemonDictationEngine(daemon, undefined, async url => {
      seen.push(url);
      return okResponse('the words');
    });
    expect(await engine.transcribe(speech(), new AbortController().signal)).toBe('the words');
    expect(seen[0]).toContain('/v1/stt/transcribe');
  });

  it('carries the session scope so the daemon can refuse a foreign session', async () => {
    const engine = daemonDictationEngine(daemon, daemonSessionScope(daemon, 'session-1'), async url =>
      okResponse(url.includes('sessionId=session-1') ? 'scoped' : 'unscoped'),
    );
    expect(await engine.transcribe(speech(), new AbortController().signal)).toBe('scoped');
  });

  it('refuses to post one daemon-s session to another daemon', async () => {
    const engine = daemonDictationEngine(daemon, daemonSessionScope(other, 'session-1'), async () =>
      okResponse('should never be reached'),
    );
    await expect(engine.transcribe(speech(), new AbortController().signal)).rejects.toThrow(
      /belongs to a different daemon/,
    );
  });
});

describe('useDictation', () => {
  it('reports itself unsupported when the browser has no microphone API', async () => {
    const view = await harness({ captureHost: null });
    expect(view.handle().supported).toBe(false);
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('takes one utterance from the microphone to the draft, once', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host, draft: 'typed' });
    expect(view.handle().supported).toBe(true);

    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('requesting');

    await interact(() => mic.openMic());
    expect(view.handle().phase).toBe('recording');
    expect(view.handle().recording).toBe(true);
    expect(view.handle().inputMonitor).not.toBeNull();

    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());

    expect(view.drafts).toEqual([{ text: 'typed hello world', caret: 17 }]);
    expect(view.handle().phase).toBe('idle');
    expect(mic.released()).toBe(1);
    await view.unmount();
  });

  it('inserts at the live caret rather than where the draft started', async () => {
    const mic = fakeCaptureHost();
    const selectionRef = { current: { selectionStart: 5, selectionEnd: 5 } };
    const view = await harness({ captureHost: mic.host, draft: 'start', selectionRef });
    await record(view, mic);
    // The reader keeps typing DURING the utterance; the commit must use this.
    await view.render({ draft: 'start end', selectionRef: { current: { selectionStart: 5, selectionEnd: 5 } } });
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toBe('start hello world end');
    await view.unmount();
  });

  it('says nothing at all about a mis-tap that captured no speech', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await interact(() => mic.emit(new Float32Array(10)));
    await interact(async () => view.handle().stop());
    expect(view.drafts).toEqual([]);
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('surfaces the daemon-s real refusal', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: failingEngine(new SttRequestError('unavailable', 'No speech model is installed.', 503)),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error).toEqual({ code: 'unavailable', message: 'No speech model is installed.' });

    await interact(() => view.handle().dismissError());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('treats an aborted transcription as a cancellation, not a failure', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: failingEngine(new SttRequestError('aborted', 'Transcription was cancelled.')),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().error).toBeNull();
    await view.unmount();
  });

  it('names a blocked microphone instead of a generic failure', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await interact(() => view.handle().start());
    await interact(async () => {
      mic.denyMic(new CaptureError('permission-denied', 'Microphone access was blocked for this site.'));
      await Promise.resolve();
    });
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('permission-denied');
    await view.unmount();
  });

  it('honours a release that arrived while the permission prompt was still up', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await interact(() => view.handle().start());
    // No live capture yet: the stop must be remembered, not dropped.
    await interact(() => view.handle().stop());
    await interact(() => mic.openMic());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().recording).toBe(false);
    expect(mic.released()).toBe(1);
    await view.unmount();
  });

  it('ignores a stop when nothing is running', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await interact(() => view.handle().stop());
    expect(view.handle().phase).toBe('idle');
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('ignores a second start while the microphone is already open', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await interact(() => view.handle().start());
    await interact(() => view.handle().start());
    await interact(() => mic.openMic());
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('recording');
    await view.unmount();
  });

  it('returns to idle when the tab goes to the background and the mic closes', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(() => mic.hide());
    expect(view.handle().phase).toBe('idle');
    expect(view.handle().inputMonitor).toBeNull();

    // The abandoned audio must not be able to reach an engine afterwards.
    await interact(async () => view.handle().stop());
    expect(view.drafts).toEqual([]);
    await view.unmount();
  });

  it('ignores a duplicate background notification', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await interact(() => mic.hide());
    await interact(() => mic.hide());
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('cancels a capture that opened after the reader gave up on it', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await interact(() => view.handle().start());
    await interact(() => view.handle().cancel());
    await interact(() => mic.openMic());
    expect(view.handle().phase).toBe('idle');
    expect(mic.released()).toBe(1);
    await view.unmount();
  });

  it('throws the recording away on cancel', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(() => view.handle().cancel());
    expect(view.handle().phase).toBe('idle');
    expect(view.drafts).toEqual([]);
    expect(mic.released()).toBe(1);
    await view.unmount();
  });

  it('finishes exactly once when the limit and a release arrive together', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    // The ceiling stops capture itself and calls back; the reader lets go too.
    await interact(() => mic.emit(speech(MAX_UTTERANCE_SECONDS + 1)));
    await interact(async () => view.handle().stop());
    expect(view.drafts).toHaveLength(1);
    await view.unmount();
  });

  it('refuses to record while dictation is switched off, and lets go of the mic', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await view.render({ settings: settingsWith({ enabled: false }) });
    expect(view.handle().phase).toBe('idle');
    expect(mic.released()).toBe(1);

    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('refuses to record while the host has disabled the control', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host, disabled: true });
    await interact(() => view.handle().start());
    expect(view.handle().phase).toBe('idle');
    await view.unmount();
  });

  it('releases the microphone on unmount', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({ captureHost: mic.host });
    await record(view, mic);
    await view.unmount();
    expect(mic.released()).toBe(1);
  });
});

describe('useDictation enhancement', () => {
  const dictionary = ['ferretry = ferretree, ferretry'];

  it('corrects a misheard term through the on-device enhancer', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: staticEngine('ferretree is running'),
      settings: settingsWith({ dictionary }),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toContain('ferretry');
    await view.unmount();
  });

  it('keeps the raw words when correction is switched off', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: staticEngine('ferretree is running'),
      settings: settingsWith({ dictionary, enhancement: false }),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toBe('ferretree is running');
    await view.unmount();
  });

  it('mines recent conversation from THIS daemon-s session, under a budget', async () => {
    const mic = fakeCaptureHost();
    const asked: Array<[string, number | undefined, number | undefined]> = [];
    const view = await harness({
      captureHost: mic.host,
      sessionId: 'session-1',
      engine: staticEngine('ferretree is running'),
      settings: settingsWith({ dictionary }),
      api: {
        history: async (id, after, limit) => {
          asked.push([id, after, limit]);
          return [];
        },
      },
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(asked).toEqual([['session-1', undefined, CONTEXT_FETCH_LIMIT]]);
    expect(view.drafts[0]?.text).toContain('ferretry');
    await view.unmount();
  });

  it('keeps the transcript when the history read fails outright', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      sessionId: 'session-1',
      engine: staticEngine('plain words'),
      api: {
        history: async () => {
          throw new Error('daemon is down');
        },
      },
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toBe('plain words');
    await view.unmount();
  });

  it('adds the corrected words but reports a Groq failure afterwards', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: staticEngine('raw words'),
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ code: 'rate_limited', error: 'Slow down.' }), { status: 429 }),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toBe('raw words');
    expect(view.drafts[0]?.enhancementError?.code).toBe('enhancement-rate-limit');
    expect(view.handle().phase).toBe('error');
    expect(view.handle().error?.code).toBe('enhancement-rate-limit');
    await view.unmount();
  });

  it('uses the Groq answer when the daemon returns one', async () => {
    const mic = fakeCaptureHost();
    const view = await harness({
      captureHost: mic.host,
      engine: staticEngine('raw words'),
      settings: settingsWith({ enhancementProvider: 'groq' }),
      enhancementFetch: async () =>
        new Response(JSON.stringify({ text: 'Raw words.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await record(view, mic);
    await interact(() => mic.emit(speech()));
    await interact(async () => view.handle().stop());
    expect(view.drafts[0]?.text).toBe('Raw words.');
    expect(view.drafts[0]?.enhancementError).toBeUndefined();
    await view.unmount();
  });
});
