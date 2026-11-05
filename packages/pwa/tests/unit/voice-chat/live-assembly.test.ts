/**
 * Proves how the Live ports are put together: the engine the person chose becomes a session (or a
 * refusal with words), the composer becomes the send port, and the pieces are wired into one set.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  BrowserRecognitionError,
  type BrowserRecognitionProvider,
  BrowserRecognitionSession,
  type SpeechRecognitionLike,
} from '../../../src/lib/stt/browser-recognition.ts';
import type { OnDeviceVoice } from '../../../src/lib/stt/on-device-voice.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../../src/lib/stt/stt-settings.ts';
import { DEFAULT_VOICE_CLEANUP } from '../../../src/lib/stt/voice-cleanup.ts';
import {
  assembleFromPage,
  assembleLivePorts,
  createLiveSession,
  type LiveComposerBridge,
  type LiveEngineDeps,
  type LiveEnvironment,
  type LivePageInputs,
} from '../../../src/lib/voice-chat/live-assembly.ts';
import type { LiveSession, LiveSessionCallbacks } from '../../../src/lib/voice-chat/live-take.ts';

const callbacks: LiveSessionCallbacks = {
  onStart: () => undefined,
  onTranscript: () => undefined,
  onFailure: () => undefined,
  onAbort: () => undefined,
  onLimit: () => undefined,
  onLiveText: () => undefined,
};

const recognition = (
  available: boolean,
  availability: 'available' | 'ios-home-screen' | 'unsupported' = available ? 'available' : 'unsupported',
): BrowserRecognitionProvider => {
  const fake = {
    continuous: false,
    interimResults: false,
    lang: '',
    maxAlternatives: 1,
    onstart: null,
    onend: null,
    onspeechstart: null,
    onresult: null,
    onnomatch: null,
    onerror: null,
    start: () => undefined,
    stop: () => undefined,
    abort: () => undefined,
  } satisfies SpeechRecognitionLike;
  return {
    support: { available, availability, implementation: available ? 'standard' : null },
    create: () => fake,
    watchHidden: () => () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
};

const settings = (engine: SttSettings['engine']): SttSettings => ({ ...DEFAULT_STT_SETTINGS, engine });

const voice = (available: boolean, make?: (options: unknown) => LiveSession): OnDeviceVoice =>
  ({
    support: { available },
    createSession: (options: unknown) =>
      (make ?? (() => ({ start: () => undefined }) as unknown as LiveSession))(options),
  }) as unknown as OnDeviceVoice;

const engineDeps = (patch: Partial<LiveEngineDeps> & { engine?: SttSettings['engine'] } = {}): LiveEngineDeps => ({
  settings: settings(patch.engine === undefined ? 'browser' : patch.engine),
  recognition: patch.recognition ?? recognition(true),
  voice: patch.voice === undefined ? null : patch.voice,
});

describe('createLiveSession — the engine the person chose', () => {
  it('refuses when no engine was chosen', () => {
    should(createLiveSession(engineDeps({ engine: null }), callbacks)).equal('engine-not-chosen');
  });

  it('makes a browser session when the browser can recognise speech', () => {
    should(createLiveSession(engineDeps({ engine: 'browser' }), callbacks)).be.instanceof(BrowserRecognitionSession);
  });

  it('refuses Browser voice that is not available, with the iPhone words on a Home Screen app', () => {
    const unavailable = recognition(false);
    const homeScreen = recognition(false, 'ios-home-screen');
    should(createLiveSession(engineDeps({ engine: 'browser', recognition: unavailable }), callbacks)).equal(
      'engine-failed',
    );
    should(createLiveSession(engineDeps({ engine: 'browser', recognition: homeScreen }), callbacks)).equal(
      'ios-browser-voice',
    );
  });

  it('makes an on-device session with live words off, so the early finish is offered', () => {
    let seen: { liveWords?: boolean } = {};
    const session = createLiveSession(
      engineDeps({
        engine: 'parakeet',
        voice: voice(true, options => {
          seen = options as { liveWords?: boolean };
          return { start: () => undefined } as unknown as LiveSession;
        }),
      }),
      callbacks,
    );
    should(typeof session).equal('object');
    should(seen.liveWords).equal(false);
  });

  it('refuses an on-device engine that is missing or unavailable here', () => {
    should(createLiveSession(engineDeps({ engine: 'parakeet', voice: null }), callbacks)).equal('engine-missing');
    should(createLiveSession(engineDeps({ engine: 'parakeet', voice: voice(false) }), callbacks)).equal(
      'engine-missing',
    );
  });

  it('turns a session that cannot be made into the words for it', () => {
    const throwing = voice(true, () => {
      throw new BrowserRecognitionError('model-not-installed', 'not installed');
    });
    should(createLiveSession(engineDeps({ engine: 'parakeet', voice: throwing }), callbacks)).equal('engine-missing');
    const odd = voice(true, () => {
      throw new Error('boom');
    });
    should(createLiveSession(engineDeps({ engine: 'parakeet', voice: odd }), callbacks)).equal('engine-failed');
  });
});

describe('assembleLivePorts', () => {
  const bridge = (submitted: boolean): LiveComposerBridge & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      show: words => void calls.push(`show:${words}`),
      clear: () => void calls.push('clear'),
      draft: () => 'the box',
      lastShown: () => null,
      submit: async () => {
        calls.push('submit');
        return submitted;
      },
    };
  };
  const assemble = (composer: LiveComposerBridge) =>
    assembleLivePorts({
      engine: () => engineDeps({ engine: null }),
      cleanup: () => {
        throw new Error('not used here');
      },
      meter: null,
      composer,
      reply: { current: () => null, subscribe: () => () => undefined },
      reader: null,
      clock: { now: () => 42, after: () => () => undefined },
      visibility: { visible: () => true, watch: () => () => undefined },
      micLock: { acquire: async () => true, release: () => undefined },
      wakeLock: { acquire: async () => true, release: () => undefined },
    });

  it('drives the composer through the send port, and reports a send as sent or not', async () => {
    const sent = bridge(true);
    const ports = assemble(sent);
    ports.send.show('hello');
    ports.send.clear();
    should(ports.send.shown()).equal('the box');
    should(await ports.send.send()).deepEqual({ kind: 'sent', sentAtMs: 42 });
    should(sent.calls).deepEqual(['show:hello', 'clear', 'submit']);
    should(await assemble(bridge(false)).send.send()).deepEqual({ kind: 'failed', reason: 'not-sent' });
  });

  it('has no reader unless the page gives one, and a take that refuses without an engine', async () => {
    const ports = assemble(bridge(true));
    should(ports.reader).equal(null);
    const events: string[] = [];
    ports.take.start({
      onLive: () => undefined,
      onEnded: () => undefined,
      onFailed: block => void events.push(block),
    });
    should(events).deepEqual(['engine-not-chosen']);
    should(await ports.levels.open(() => undefined)).equal(null);
  });

  it('cleans through the page cleanup deps', async () => {
    let asked = 0;
    const ports = assembleLivePorts({
      engine: () => engineDeps({ engine: 'browser' }),
      cleanup: () => {
        asked += 1;
        return {
          settings: { ...DEFAULT_STT_SETTINGS, enhancement: false },
          cleanup: { style: 'fix', prompts: {}, useConversation: false, conversationMessages: 8 },
          keys: null,
          daemon: {} as never,
          fetchImpl: async () => new Response(),
          readContext: () => [],
        };
      },
      meter: null,
      composer: bridge(true),
      reply: { current: () => null, subscribe: () => () => undefined },
      reader: null,
      clock: { now: () => 0, after: () => () => undefined },
      visibility: { visible: () => true, watch: () => () => undefined },
      micLock: { acquire: async () => true, release: () => undefined },
      wakeLock: { acquire: async () => true, release: () => undefined },
    });
    const take = ports.take.start({ onLive: () => undefined, onEnded: () => undefined, onFailed: () => undefined });
    take.cancel();
    should(asked).equal(0);
  });
});

describe('assembleFromPage', () => {
  const page = (patch: Partial<LivePageInputs> = {}): LivePageInputs => ({
    settings: settings('browser'),
    recognition: recognition(true),
    voice: null,
    cleanup: DEFAULT_VOICE_CLEANUP,
    keys: null,
    daemon: {} as never,
    fetchImpl: async () => new Response(),
    readContext: () => ['one message'],
    meter: null,
    ...patch,
  });
  const environment = (): LiveEnvironment => ({
    composer: {
      show: () => undefined,
      clear: () => undefined,
      draft: () => '',
      lastShown: () => null,
      submit: async () => true,
    },
    reply: { current: () => null, subscribe: () => () => undefined },
    reader: null,
    clock: { now: () => 0, after: () => () => undefined },
    visibility: { visible: () => true, watch: () => () => undefined },
    micLock: { acquire: async () => true, release: () => undefined },
    wakeLock: { acquire: async () => true, release: () => undefined },
  });

  it('reads the page afresh for every take and for the clean-up of each', async () => {
    let reads = 0;
    let current = page({ settings: settings(null) });
    const ports = assembleFromPage(() => {
      reads += 1;
      return current;
    }, environment());
    const events: string[] = [];
    const listener = {
      onLive: () => undefined,
      onEnded: () => undefined,
      onFailed: (block: string) => void events.push(block),
    };
    ports.take.start(listener);
    should(events).deepEqual(['engine-not-chosen']);
    // The person chose an engine since: the next take reads that.
    current = page({ settings: settings('browser') });
    const take = ports.take.start({ ...listener, onFailed: () => undefined });
    should(reads).be.aboveOrEqual(3);
    take.cancel();
  });

  it('ends a turn through the engine and the clean-up settings of the page', async () => {
    const session = {
      start: () => undefined,
      cancel: () => undefined,
      finish: async () => 'hello wold',
    } as unknown as LiveSession;
    const ports = assembleFromPage(
      () =>
        page({
          settings: { ...settings('parakeet'), enhancement: false },
          voice: voice(true, () => session),
        }),
      environment(),
    );
    const take = ports.take.start({ onLive: () => undefined, onEnded: () => undefined, onFailed: () => undefined });
    should(await take.endTurn()).deepEqual({ kind: 'words', text: 'hello wold', raw: 'hello wold', cleaned: false });
    take.cancel();
  });
});
