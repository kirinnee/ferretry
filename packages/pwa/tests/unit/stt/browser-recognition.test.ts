import { describe, it } from 'node:test';
import should from 'should';
import {
  type BrowserRecognitionProvider,
  BrowserRecognitionSession,
  type BrowserRecognitionSupport,
  browserRecognitionErrorFrom,
  browserRecognitionProvider,
  joinRecognitionChunks,
  mergeRecognitionChunks,
  readBrowserRecognitionSupport,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
} from '../../../src/lib/stt/browser-recognition.ts';

const AVAILABLE: BrowserRecognitionSupport = {
  available: true,
  availability: 'available',
  implementation: 'standard',
};

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onnomatch: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  starts = 0;
  stops = 0;
  aborts = 0;
  startFailure: unknown;

  start(): void {
    this.starts += 1;
    if (this.startFailure !== undefined) throw this.startFailure;
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }

  result(chunks: readonly { text: string; final?: boolean }[], resultIndex = 0): void {
    const results = chunks.map(chunk => ({
      0: { transcript: chunk.text, confidence: 0.8 },
      isFinal: chunk.final ?? false,
      length: 1,
    }));
    this.onresult?.({ resultIndex, results });
  }
}

interface FakeProvider extends BrowserRecognitionProvider {
  readonly recognition: FakeRecognition;
  hidden(): void;
  fireTimers(): void;
  fireLatest(): void;
}

const fakeProvider = (): FakeProvider => {
  const recognition = new FakeRecognition();
  let hiddenListener: (() => void) | null = null;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  return {
    support: AVAILABLE,
    recognition,
    create: () => recognition,
    watchHidden: listener => {
      hiddenListener = listener;
      return () => {
        if (hiddenListener === listener) hiddenListener = null;
      };
    },
    setTimeout: callback => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: handle => {
      timers.delete(handle as number);
    },
    hidden: () => hiddenListener?.(),
    fireLatest: () => {
      const latest = Math.max(...timers.keys());
      const callback = timers.get(latest);
      timers.delete(latest);
      callback?.();
    },
    fireTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
};

const sessionHarness = (platform: { readonly android?: boolean } = {}) => {
  const provider = Object.assign(fakeProvider(), platform);
  const starts: number[] = [];
  const transcripts: string[] = [];
  const failures: { code: string; message: string }[] = [];
  let aborted = 0;
  let limited = 0;
  const session = new BrowserRecognitionSession(provider, {
    onStart: () => starts.push(starts.length + 1),
    onTranscript: text => transcripts.push(text),
    onFailure: failure => failures.push({ code: failure.code, message: failure.message }),
    onAbort: () => {
      aborted += 1;
    },
    onLimit: () => {
      limited += 1;
    },
  });
  return {
    provider,
    session,
    starts,
    transcripts,
    failures,
    aborted: () => aborted,
    limited: () => limited,
  };
};

describe('readBrowserRecognitionSupport', () => {
  class Recognition extends FakeRecognition {}

  it('prefers the standard constructor when both forms are exposed', () => {
    const support = readBrowserRecognitionSupport({
      isSecureContext: true,
      SpeechRecognition: Recognition,
      webkitSpeechRecognition: Recognition,
    });
    should(support).deepEqual({ available: true, availability: 'available', implementation: 'standard' });
  });

  it('accepts the prefixed constructor used by iOS Safari', () => {
    const support = readBrowserRecognitionSupport({
      isSecureContext: true,
      webkitSpeechRecognition: Recognition,
      navigator: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' },
    });
    should(support).deepEqual({ available: true, availability: 'available', implementation: 'webkit' });
  });

  it('fails closed in an installed iOS Home Screen app even when the constructor is exposed', () => {
    const support = readBrowserRecognitionSupport({
      isSecureContext: true,
      webkitSpeechRecognition: Recognition,
      navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
        maxTouchPoints: 5,
        standalone: true,
      },
    });
    should(support.available).be.false();
    should(support.availability).equal('ios-home-screen');
    should(support.reason).match(/Open Ferretry in Safari/u);
  });

  it('names an insecure page before constructor absence', () => {
    const support = readBrowserRecognitionSupport({ isSecureContext: false });
    should(support.availability).equal('insecure-context');
    should(support.reason).match(/secure HTTPS/u);
  });

  it('names an unsupported browser instead of treating it as an empty microphone', () => {
    const support = readBrowserRecognitionSupport({ isSecureContext: true });
    should(support).deepEqual({
      available: false,
      availability: 'unsupported',
      implementation: null,
      reason: 'This browser does not support dictation for web apps.',
    });
  });
});

describe('browserRecognitionProvider', () => {
  class Recognition extends FakeRecognition {}

  it('constructs the exposed engine and owns visibility and timer cleanup', () => {
    const callbacks: { visibility?: () => void; timer?: () => void } = {};
    let visibility = 'visible';
    let hidden = 0;
    let cleared: unknown;
    const provider = browserRecognitionProvider({
      isSecureContext: true,
      webkitSpeechRecognition: Recognition,
      document: {
        get visibilityState() {
          return visibility;
        },
        addEventListener: (_type, listener) => {
          callbacks.visibility = listener;
        },
        removeEventListener: (_type, listener) => {
          if (callbacks.visibility === listener) delete callbacks.visibility;
        },
      },
      setTimeout: callback => {
        callbacks.timer = callback;
        return 17;
      },
      clearTimeout: handle => {
        cleared = handle;
      },
    });

    should(provider.create()).be.instanceOf(Recognition);
    const unwatch = provider.watchHidden(() => {
      hidden += 1;
    });
    callbacks.visibility?.();
    should(hidden).equal(0);
    visibility = 'hidden';
    callbacks.visibility?.();
    should(hidden).equal(1);
    unwatch();
    should(callbacks.visibility).equal(undefined);

    const timer = provider.setTimeout(() => undefined, 10);
    callbacks.timer?.();
    provider.clearTimeout(timer);
    should(cleared).equal(17);
  });

  it('fails closed without an engine and treats an absent document as unwatched', () => {
    const provider = browserRecognitionProvider({ isSecureContext: true });
    should(() => provider.create()).throw(/does not support dictation/u);
    provider.watchHidden(() => undefined)();
  });
});

describe('browserRecognitionErrorFrom', () => {
  it('keeps a microphone refusal distinct from an absent device', () => {
    should(browserRecognitionErrorFrom({ error: 'not-allowed' }).code).equal('permission-denied');
    should(browserRecognitionErrorFrom({ error: 'audio-capture' }).code).equal('no-microphone');
  });

  it('names browser-service and browser-capability failures without mentioning a daemon', () => {
    should(browserRecognitionErrorFrom({ error: 'network' }).code).equal('recognition-network');
    should(browserRecognitionErrorFrom({ error: 'service-not-allowed' }).code).equal('recognition-unavailable');
    should(browserRecognitionErrorFrom({ error: 'language-not-supported' }).code).equal('recognition-unavailable');
  });

  it('maps every alias onto the same code as the Web Speech value beside it', () => {
    // One `error` value and one DOM `name` share each branch. Line coverage
    // cannot tell them apart, so each alias is named here on purpose.
    const cases: readonly [{ error?: string; name?: string }, string][] = [
      [{ error: 'not-allowed' }, 'permission-denied'],
      [{ name: 'NotAllowedError' }, 'permission-denied'],
      [{ name: 'SecurityError' }, 'permission-denied'],
      [{ error: 'audio-capture' }, 'no-microphone'],
      [{ name: 'NotReadableError' }, 'no-microphone'],
      [{ name: 'NotFoundError' }, 'no-microphone'],
      [{ error: 'service-not-allowed' }, 'recognition-unavailable'],
      [{ error: 'language-not-supported' }, 'recognition-unavailable'],
      [{ error: 'phrases-not-supported' }, 'recognition-unavailable'],
      [{ name: 'NotSupportedError' }, 'recognition-unavailable'],
      [{ error: 'aborted' }, 'aborted'],
      [{ name: 'AbortError' }, 'aborted'],
      [{ error: 'anything-the-spec-adds-later' }, 'recognition-failed'],
    ];

    for (const [failure, code] of cases) should(browserRecognitionErrorFrom(failure).code).equal(code);
  });

  it('prefers the engine’s own message, trimmed, and never re-wraps its own error', () => {
    should(browserRecognitionErrorFrom({ error: 'network', message: '  service unreachable  ' }).message).equal(
      'service unreachable',
    );
    should(browserRecognitionErrorFrom({ error: 'network', message: '   ' }).message).match(/could not be reached/u);
    should(browserRecognitionErrorFrom(null).code).equal('recognition-failed');

    const already = browserRecognitionErrorFrom({ error: 'not-allowed' });
    should(browserRecognitionErrorFrom(already)).equal(already);
  });
});

describe('BrowserRecognitionSession', () => {
  it('starts with continuous interim English recognition configured before the gesture returns', () => {
    const { provider, session } = sessionHarness();
    session.start();
    should(provider.recognition.starts).equal(1);
    should(provider.recognition.continuous).be.true();
    should(provider.recognition.interimResults).be.true();
    should(provider.recognition.lang).equal('en-US');
    should(provider.recognition.maxAlternatives).equal(1);
  });

  it('replaces interim results by resultIndex and finishes with the final words once', async () => {
    const { provider, session, transcripts } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.result([{ text: 'hello wor', final: false }]);
    provider.recognition.result([{ text: 'hello world', final: true }]);
    const finished = session.finish();
    provider.recognition.onend?.();

    should(await finished).equal('hello world');
    should(transcripts).deepEqual(['hello wor', 'hello world', 'hello world']);
    should(provider.recognition.stops).equal(1);
  });

  it('restarts after a mobile-style natural end and retains both settled cycles', async () => {
    const { provider, session, starts } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.result([{ text: 'first phrase', final: true }]);
    provider.recognition.onend?.();
    should(provider.recognition.starts).equal(2);

    provider.recognition.onstart?.();
    provider.recognition.result([{ text: 'second phrase', final: true }]);
    const finished = session.finish();
    provider.recognition.onend?.();

    should(await finished).equal('first phrase second phrase');
    should(starts).deepEqual([1, 2]);
  });

  it('returns empty only when the recognizer observed no speech', async () => {
    const { provider, session, failures } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.onerror?.({ error: 'no-speech' });
    const finished = session.finish();
    provider.recognition.onend?.();
    should(await finished).equal('');
    should(failures).deepEqual([]);
  });

  it('reports heard-but-unmatched speech as a failed transcription, never an empty one', async () => {
    const { provider, session, failures } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.onspeechstart?.();
    provider.recognition.onnomatch?.({ resultIndex: 0, results: [] });
    const finished = session.finish();
    provider.recognition.onend?.();
    await should(finished).be.rejectedWith({ code: 'bad-audio' });
    should(failures[0]?.code).equal('bad-audio');
  });

  it('surfaces permission refusal immediately and does not restart after the error end', () => {
    const { provider, session, failures } = sessionHarness();
    session.start();
    provider.recognition.onerror?.({ error: 'not-allowed', message: 'denied by reader' });
    provider.recognition.onend?.();
    should(failures).deepEqual([{ code: 'permission-denied', message: 'denied by reader' }]);
    should(provider.recognition.starts).equal(1);
  });

  it('aborts the restarted cycle when a terminal error follows the end instead of preceding it', () => {
    const { provider, session, failures, transcripts } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.result([{ text: 'half a sentence', final: false }]);

    // Web Speech does not order `end` against `error`. When the engine
    // announces its network failure second, the `end` before it has already
    // opened another cycle, so the failure has to close a live microphone
    // rather than only marking this session failed.
    provider.recognition.onend?.();
    should(provider.recognition.starts).equal(2);
    provider.recognition.onstart?.();
    provider.recognition.onerror?.({ error: 'network' });

    should(provider.recognition.starts).equal(2);
    should(provider.recognition.aborts).equal(1);
    should(failures).deepEqual([
      { code: 'recognition-network', message: 'The browser speech service could not be reached.' },
    ]);

    // The `aborted` callbacks that abort itself delivers may neither restart
    // the engine again nor replace the failure the reader is reading.
    const afterFailure = transcripts.length;
    provider.recognition.onerror?.({ error: 'aborted' });
    provider.recognition.onend?.();
    should(provider.recognition.starts).equal(2);
    should(provider.recognition.aborts).equal(1);
    should(failures).have.length(1);
    should(failures[0]?.code).equal('recognition-network');
    should(transcripts).have.length(afterFailure);
  });

  it('aborts and notifies when the page becomes hidden', () => {
    const { provider, session, aborted } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.hidden();
    should(aborted()).equal(1);
    should(provider.recognition.aborts).equal(1);
  });

  it('raises the hard duration callback without silently ending the session', () => {
    const { provider, session, limited } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.fireTimers();
    should(limited()).equal(1);
    should(provider.recognition.aborts).equal(0);
  });

  it('ignores a stray end after the take has already settled', async () => {
    const { provider, session, transcripts } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    provider.recognition.result([{ text: 'settled words', final: true }]);
    const finished = session.finish();
    provider.recognition.onend?.();
    should(await finished).equal('settled words');

    const settled = transcripts.length;
    // Some engines emit a second `end` of their own after the one that settled
    // the take. The panel is closed and the words are already in the draft, so
    // neither another caption nor another recognition cycle may follow.
    provider.recognition.onend?.();
    should(transcripts).have.length(settled);
    should(provider.recognition.starts).equal(1);
  });

  it('ignores an end that arrives after a failure or a cancel', () => {
    const failed = sessionHarness();
    failed.session.start();
    failed.provider.recognition.onstart?.();
    failed.provider.recognition.result([{ text: 'half a thought', final: false }]);
    failed.provider.recognition.onerror?.({ error: 'not-allowed' });
    const afterFailure = failed.transcripts.length;
    failed.provider.recognition.onend?.();
    should(failed.transcripts).have.length(afterFailure);
    should(failed.failures).have.length(1);

    const cancelled = sessionHarness();
    cancelled.session.start();
    cancelled.provider.recognition.onstart?.();
    cancelled.provider.recognition.result([{ text: 'never mind', final: true }]);
    cancelled.session.cancel();
    const afterCancel = cancelled.transcripts.length;
    cancelled.provider.recognition.onend?.();
    should(cancelled.transcripts).have.length(afterCancel);
    should(cancelled.provider.recognition.starts).equal(1);
  });

  it('reads a result list that only offers item(), as older WebKit does', async () => {
    const { provider, session } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();

    const alternative = { transcript: 'item shaped words', confidence: 0.9 };
    const first = { isFinal: true, length: 1, item: (index: number) => (index === 0 ? alternative : null) };
    // The second result has neither an index nor an alternative to offer: an
    // engine mid-rewrite. It contributes nothing rather than throwing.
    const second = { isFinal: false, length: 1, item: () => null };
    provider.recognition.onresult?.({
      resultIndex: 0,
      results: { length: 3, item: (index: number) => [first, second][index] ?? null },
    });

    const finished = session.finish();
    provider.recognition.onend?.();
    should(await finished).equal('item shaped words');
  });

  it('fails closed when the browser never settles Stop', async () => {
    const { provider, session, failures } = sessionHarness();
    session.start();
    provider.recognition.onstart?.();
    const finished = session.finish();
    provider.fireTimers();
    await should(finished).be.rejectedWith({ code: 'recognition-failed' });
    should(failures[0]?.message).match(/did not finish/u);
    should(provider.recognition.aborts).equal(1);
  });
});

describe('joinRecognitionChunks', () => {
  it('keeps punctuation while normalising result-boundary whitespace', () => {
    should(joinRecognitionChunks(['  hello, ', '   world.'])).equal('hello, world.');
  });
});

/**
 * Replays of event sequences the three engine families produce, one session each. The Android shapes
 * follow the reports cited in the PR: cumulative transcripts at growing indices, interim-only takes
 * whose last hypothesis is never marked final, and errors that arrive after speech.
 */
describe('BrowserRecognitionSession on recorded engine sequences', () => {
  type Chunk = { text: string; final?: boolean };
  const cumulative = (provider: { recognition: FakeRecognition }, chunks: readonly Chunk[], resultIndex = 0): void =>
    provider.recognition.result(chunks, resultIndex);

  describe('Android Chrome', () => {
    it('keeps interim-only speech when the take ends without any final result', async () => {
      const { provider, session } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onspeechstart?.();
      cumulative(provider, [{ text: 'send the report' }]);
      cumulative(provider, [{ text: 'send the report to Sam' }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('send the report to Sam');
    });

    it('waits for a result that arrives after the end of a Stop, then settles on it', async () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onspeechstart?.();
      const finished = session.finish();
      provider.recognition.onend?.();
      should(failures).deepEqual([]);

      cumulative(provider, [{ text: 'late words', final: true }]);
      provider.fireLatest();
      should(await finished).equal('late words');
      should(failures).deepEqual([]);
    });

    it('says what to do when speech was heard but the service returned no words at all', async () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onspeechstart?.();
      const finished = session.finish();
      provider.recognition.onend?.();
      provider.fireLatest();
      await should(finished).be.rejectedWith({ code: 'bad-audio' });
      should(failures[0]?.message).equal("Android's speech service returned no words.");
    });

    it('collapses a cumulative transcript re-emitted at every growing index', async () => {
      const { provider, session, transcripts } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'hello', final: true }]);
      cumulative(
        provider,
        [
          { text: 'hello', final: true },
          { text: 'hello there', final: true },
        ],
        1,
      );
      cumulative(
        provider,
        [{ text: 'hello', final: true }, { text: 'hello there', final: true }, { text: 'hello there my friend' }],
        2,
      );
      should(transcripts.at(-1)).equal('hello there my friend');
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('hello there my friend');
    });

    it('does not duplicate a cycle that the restarted engine replays in full', async () => {
      const { provider, session } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'please book the flight', final: true }]);
      provider.recognition.onend?.();
      should(provider.recognition.starts).equal(2);

      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'please book the flight', final: true }]);
      cumulative(provider, [{ text: 'please book the flight for Tuesday' }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('please book the flight for Tuesday');
    });

    it('keeps genuinely new words across restart cycles', async () => {
      const { provider, session } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'first thought here', final: true }]);
      provider.recognition.onend?.();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'second thought' }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('first thought here second thought');
    });

    it('keeps the words when aborted arrives after speech while a Stop is finishing', async () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'before the drop' }]);
      const finished = session.finish();
      provider.recognition.onerror?.({ error: 'aborted' });
      provider.recognition.onend?.();
      should(await finished).equal('before the drop');
      should(failures).deepEqual([]);
    });

    it('treats an abort while still recording as another recogniser taking the microphone', () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'before the drop' }]);
      provider.recognition.onerror?.({ error: 'aborted' });
      should(failures[0]?.code).equal('aborted');
    });

    it('keeps the words when a network error and the end arrive while finishing', async () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'what was said' }]);
      const finished = session.finish();
      provider.recognition.onerror?.({ error: 'network' });
      provider.recognition.onend?.();
      should(await finished).equal('what was said');
      should(failures).deepEqual([]);
    });

    it('still fails a network error that left nothing to keep, and audio-capture always', async () => {
      const network = sessionHarness({ android: true });
      network.session.start();
      network.provider.recognition.onstart?.();
      network.provider.recognition.onerror?.({ error: 'network' });
      should(network.failures[0]?.code).equal('recognition-network');

      const capture = sessionHarness({ android: true });
      capture.session.start();
      capture.provider.recognition.onstart?.();
      cumulative(capture.provider, [{ text: 'words' }]);
      capture.provider.recognition.onerror?.({ error: 'audio-capture' });
      should(capture.failures[0]?.code).equal('no-microphone');
    });

    it('rides out silence timeouts: no-speech then end restarts without failing', () => {
      const { provider, session, failures } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onerror?.({ error: 'no-speech' });
      provider.recognition.onend?.();
      should(provider.recognition.starts).equal(2);
      should(failures).deepEqual([]);
    });

    it('stops with stop(), never abort(), when the reader finishes', async () => {
      const { provider, session } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'words' }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      await finished;
      should(provider.recognition.stops).equal(1);
      should(provider.recognition.aborts).equal(0);
    });

    it('does not wait out a grace period when the engine reported no match', async () => {
      const { provider, session } = sessionHarness({ android: true });
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onnomatch?.({ resultIndex: 0, results: [] });
      const finished = session.finish();
      provider.recognition.onend?.();
      await should(finished).be.rejectedWith({ code: 'bad-audio' });
    });
  });

  describe('desktop Chrome', () => {
    it('joins separate final segments and replaces an interim tail by resultIndex', async () => {
      const { provider, session } = sessionHarness();
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'open the', final: false }]);
      cumulative(provider, [{ text: 'open the file', final: true }]);
      cumulative(
        provider,
        [
          { text: 'open the file', final: true },
          { text: ' and read', final: false },
        ],
        1,
      );
      cumulative(
        provider,
        [
          { text: 'open the file', final: true },
          { text: ' and read it', final: true },
        ],
        1,
      );
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('open the file and read it');
    });

    it('keeps a deliberately repeated single word across finals', async () => {
      const { provider, session } = sessionHarness();
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'no', final: true }]);
      cumulative(
        provider,
        [
          { text: 'no', final: true },
          { text: ' no way', final: true },
        ],
        1,
      );
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('no no way');
    });

    it('returns empty, not a failure, when nothing was heard', async () => {
      const { provider, session, failures } = sessionHarness();
      session.start();
      provider.recognition.onstart?.();
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('');
      should(failures).deepEqual([]);
    });
  });

  describe('Safari', () => {
    it('reads a single final result from a non-continuous-style take', async () => {
      const { provider, session } = sessionHarness();
      session.start();
      provider.recognition.onstart?.();
      provider.recognition.onspeechstart?.();
      cumulative(provider, [{ text: 'Remind me at five', final: true }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('Remind me at five');
    });

    it('treats a trailing-punctuation rewrite of the last phrase as the same phrase', async () => {
      const { provider, session } = sessionHarness();
      session.start();
      provider.recognition.onstart?.();
      cumulative(provider, [{ text: 'call mom' }]);
      cumulative(provider, [{ text: 'Call mom.' }, { text: ' Then dinner' }]);
      const finished = session.finish();
      provider.recognition.onend?.();
      should(await finished).equal('Call mom. Then dinner');
    });
  });
});

describe('mergeRecognitionChunks', () => {
  it('replaces a word-wise prefix but never a partial word', () => {
    should(
      mergeRecognitionChunks([
        { text: 'to my', final: true },
        { text: 'to myself', final: true },
      ]),
    ).equal('to my to myself');
  });

  it('drops blank chunks', () => {
    should(mergeRecognitionChunks([{ text: '  ', final: true }])).equal('');
  });
});
