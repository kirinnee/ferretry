/**
 * Voice mode's settings group (`VoiceModeSettings`) over a fake machine, in the page-wide column a Settings tab gives it.
 * `?theme=<family>-<mode>&state=not_installed|ready|failed`. The fake machine downloads 35 % more on every read once Install
 * is pressed, and records every call on `window.__fake`: no audio and no secret exists in this scene to record.
 *
 * `&reply=not_installed|installing|ready|failed` is the reply voice's own row (default `not_installed`), and `&hear=ok|absent|failed`
 * scripts the sentence "Hear it" speaks through a fake socket and a fake player (no sound exists in this scene).
 *
 * `&talk=hearing|heard|refused` scripts what the machine says to Talk to test after the person presses it (a fake socket and
 * a fake microphone that sends silent units, so units are counted but no audio exists): `hearing` stops at interim words,
 * `heard` runs on to the final words, `refused` is the machine saying it has no memory and closing.
 */
import { createRoot } from 'react-dom/client';
import {
  encodeDownlinkUnit,
  encodeReplyDownlinkUnit,
  type ReplyState,
  type StreamSnapshot,
} from '../../../../contract/index.ts';
import type { MicSource, ReplyPlayer } from '../../../../app/lib/stream/voice-stream.ts';
import type { SpeakerPort } from '../../../../app/lib/voice-chat/ports.ts';
import { VoiceModeSettings } from '../../../../app/features/settings/voice-mode-settings.tsx';
import { daemonConnection } from '../../../../app/shell-voice.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/**
 * `&runtime=native|nobuild|failed|upgrade` says which engine the machine runs once an engine is Ready, and sizes the downloads
 * as the native plan (without it the scene is the WebAssembly engine, as before, and the views carry no `runtime`):
 * `native` the fast engine; `nobuild` the slower one because this platform has no native build; `failed` the slower one
 * because the native library would not start; `upgrade` the slower one on a machine that could run the fast one, with the
 * button that switches (Install then ends on `native`).
 */
const runtime = params.get('runtime');
/** Which rows the person has switched to the fast engine in the `upgrade` scenario. */
const upgraded = { speech: false, voice: false };
const sentenceOf = (
  what: 'speech' | 'voice',
): { kind: 'native' | 'wasm'; threads: number; sentence: string; upgradeBytes?: number } => {
  const doing = what === 'speech' ? 'turns your speech into words' : 'speaks';
  if (runtime === 'native' || (runtime === 'upgrade' && upgraded[what]))
    return {
      kind: 'native',
      threads: 4,
      sentence: `The fast native engine ${what === 'speech' ? 'is turning your speech into words' : 'is running it'} on Studio Mac, on up to 4 threads.`,
    };
  if (runtime === 'nobuild')
    return {
      kind: 'wasm',
      threads: 1,
      sentence: `There is no native engine for freebsd-x64, so Studio Mac ${doing} on the slower built-in engine.`,
    };
  if (runtime === 'failed')
    return {
      kind: 'wasm',
      threads: 1,
      sentence:
        'The fast native engine could not start on Studio Mac (libstdc++.so.6: cannot open shared object file), so it runs on the slower built-in engine.',
    };
  return {
    kind: 'wasm',
    threads: 1,
    sentence: 'Studio Mac runs it on the slower built-in engine. The fast native engine can be installed in its place.',
    upgradeBytes: what === 'speech' ? 33_839_377 : 359_399_933,
  };
};

const SIZE = runtime === null ? 698_905_830 : 718_956_269;
const fake = {
  installs: 0,
  removes: 0,
  reads: 0,
  starts: [] as string[],
  units: 0,
  closed: [] as unknown[],
  micStopped: 0,
  replyInstalls: 0,
  replyRemoves: 0,
  hearStarts: [] as string[],
  hearFrames: [] as string[],
  played: 0,
  playerClosed: 0,
  deviceSpoke: [] as string[],
};
(window as unknown as { __fake: typeof fake }).__fake = fake;
let state = (params.get('state') ?? 'not_installed') as 'not_installed' | 'installing' | 'ready' | 'failed';
let done = state === 'ready' ? SIZE : 0;

const view = () => ({
  state,
  machine: 'Studio Mac',
  label: 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection',
  sizeBytes: SIZE,
  doneBytes: done,
  loaded: false,
  ...(state === 'failed'
    ? {
        failure: {
          code: 'hash_mismatch',
          sentence: 'A downloaded speech file was not the file this version expects, so nothing was kept. Try again.',
        },
      }
    : {}),
  ...(state === 'ready'
    ? {
        selfTest: { loadMs: 1865, decodeMs: 650, memoryMb: 819 },
        ...(runtime === null ? {} : { runtime: sentenceOf('speech') }),
      }
    : {}),
});

const REPLY_SIZE = runtime === null ? 164_022_376 : 393_558_465;
let replyState = (params.get('reply') ?? 'not_installed') as 'not_installed' | 'installing' | 'ready' | 'failed';
let replyDone = replyState === 'ready' ? REPLY_SIZE : 0;
const replyView = () => ({
  state: replyState,
  machine: 'Studio Mac',
  label: 'Kokoro 82M, a natural English reply voice',
  sizeBytes: REPLY_SIZE,
  doneBytes: replyDone,
  loaded: false,
  ...(replyState === 'failed'
    ? {
        failure: {
          code: 'download_failed',
          sentence: 'The reply voice could not be downloaded. Check this machine’s internet and try again.',
        },
      }
    : {}),
  ...(replyState === 'ready'
    ? {
        selfTest: { loadMs: 1765, speakMs: 5163, audioMs: 1618, realTimeFactor: 3.19, memoryMb: 512 },
        ...(runtime === null ? {} : { runtime: sentenceOf('voice') }),
      }
    : {}),
});

// ─── ElevenLabs as the reply voice (`&source=kokoro|elevenlabs`, `&key=set|unset`, `&voice=none|george`, `&hold=1`) ─────
// `hold=1` is the machine holding the move to ElevenLabs for the owner to confirm (a pending write). Every call is recorded.
const GEORGE = 'JBFqnCBsd6RMkjVDRZzb';
const eleven = {
  source: (params.get('source') ?? 'kokoro') as 'kokoro' | 'elevenlabs',
  keySet: params.get('key') === 'set',
  voiceId: params.get('voice') === 'george' ? GEORGE : (undefined as string | undefined),
  voiceName: params.get('voice') === 'george' ? 'George' : (undefined as string | undefined),
  used: Number(params.get('used') ?? 1_240),
  loads: 0,
  writes: [] as string[],
  secrets: 0,
  tests: 0,
};
(window as unknown as { __eleven: typeof eleven }).__eleven = eleven;
const voiceYaml = (): string =>
  eleven.source === 'kokoro'
    ? ''
    : `replyVoice:\n  provider: elevenlabs\n${
        eleven.voiceId === undefined
          ? ''
          : `  elevenlabs:\n    voiceId: ${eleven.voiceId}\n    voiceName: ${eleven.voiceName}\n`
      }`;
const speedupsView = () => ({
  vault: 'ok',
  providers: [
    {
      provider: 'elevenlabs',
      label: 'ElevenLabs',
      purpose:
        'An optional voice for voice mode: a ferret’s spoken lines are read in a natural ElevenLabs voice of your choice.',
      costNote: 'Billed by ElevenLabs per character spoken.',
      privacyNote: 'The text of each spoken line is sent to ElevenLabs.',
      keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
      testNote: 'Test lists the models your key can use. It is free and speaks nothing.',
      secretName: 'ELEVENLABS_API_KEY',
      set: eleven.keySet,
      ...(eleven.keySet ? { secretUpdatedAt: '2026-11-24T12:00:00.000Z' } : {}),
      testStale: false,
    },
  ],
});
const elevenClient = (path: string, init?: RequestInit): unknown | undefined => {
  if (path.startsWith('/v1/config/file')) {
    if (init?.method === 'PUT') {
      const text = (JSON.parse(String(init.body)) as { text: string }).text;
      eleven.writes.push(text);
      const wantsEleven = /provider: elevenlabs/u.test(text);
      if (wantsEleven) eleven.source = 'elevenlabs';
      else eleven.source = 'kokoro';
      const match = /voiceId: (\w+)\n\s+voiceName: (.+)/u.exec(text);
      if (match !== null) {
        eleven.voiceId = match[1];
        eleven.voiceName = match[2];
      }
      return params.get('hold') === '1' && wantsEleven
        ? {
            outcome: 'pending',
            pending: {
              changes: ['a ferret’s spoken lines now go to ElevenLabs to be read aloud, billed per character'],
            },
          }
        : { outcome: 'applied' };
    }
    return { text: voiceYaml(), etag: `etag-${eleven.writes.length}` };
  }
  if (path === '/v1/voice/reply-voice/elevenlabs/voices') {
    eleven.loads += 1;
    return {
      voices: [
        { id: GEORGE, name: 'George', category: 'premade' },
        { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade' },
        { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (my clone)', category: 'cloned' },
      ],
    };
  }
  if (path === '/v1/voice/reply-voice/elevenlabs')
    return {
      usage: { day: '2026-11-24', usedChars: eleven.used, dailyChars: 20_000 },
      keySet: eleven.keySet,
      ...(eleven.voiceId === undefined ? {} : { voiceId: eleven.voiceId }),
      model: 'eleven_flash_v2_5',
    };
  if (path.startsWith('/v1/speedups/elevenlabs/test')) {
    eleven.tests += 1;
    return {
      provider: 'elevenlabs',
      secretName: 'ELEVENLABS_API_KEY',
      ok: true,
      code: 'ok',
      message: 'The key works.',
      latencyMs: 180,
      at: '2026-11-24T12:01:00.000Z',
    };
  }
  if (path === '/v1/speedups') return speedupsView();
  if (path === '/v1/secrets') {
    eleven.secrets += 1;
    eleven.keySet = true;
    return {};
  }
  return undefined;
};

const client = {
  request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
    const elevenAnswer = elevenClient(path, init);
    if (elevenAnswer !== undefined) return schema.parse(elevenAnswer);
    if (path.startsWith('/v1/voice/reply-voice')) {
      if (init?.method === 'POST') {
        fake.replyInstalls += 1;
        replyState = 'installing';
        replyDone = 0;
      } else if (init?.method === 'DELETE') {
        fake.replyRemoves += 1;
        replyState = 'not_installed';
        replyDone = 0;
      } else if (replyState === 'installing') {
        replyDone = Math.min(REPLY_SIZE, replyDone + Math.round(REPLY_SIZE * 0.5));
        if (replyDone >= REPLY_SIZE) {
          replyState = 'ready';
          upgraded.voice = true;
        }
      }
      return schema.parse(replyView());
    }
    if (init?.method === 'POST') {
      fake.installs += 1;
      state = 'installing';
      done = 0;
    } else if (init?.method === 'DELETE') {
      fake.removes += 1;
      state = 'not_installed';
      done = 0;
    } else {
      fake.reads += 1;
      if (state === 'installing') {
        done = Math.min(SIZE, done + Math.round(SIZE * 0.35));
        if (done >= SIZE) {
          state = 'ready';
          upgraded.speech = true;
        }
      }
    }
    return schema.parse(view());
  },
};

const talk = params.get('talk') ?? 'heard';
const snapshot = (patch: Partial<StreamSnapshot>): Uint8Array =>
  encodeDownlinkUnit({ v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0, ...patch });
const words = (text: string, final: boolean) => ({
  turn: 1,
  rev: final ? 2 : 1,
  offset: 0,
  total: text.length,
  text,
  final,
});

const fakeMic: MicSource = {
  start: async onUnit => {
    const timer = setInterval(() => {
      fake.units += 1;
      onUnit(new Int16Array(640));
    }, 40);
    fakeMic.stop = () => {
      fake.micStopped += 1;
      clearInterval(timer);
    };
  },
  stop: () => undefined,
};

const talkClient = {
  socket: (
    _route: string,
    _params: unknown,
    listeners: {
      onOpen?: () => void;
      onFrame: (frame: Uint8Array) => void;
      onClose: (reason: string, code?: number) => void;
    },
  ) => {
    setTimeout(() => listeners.onOpen?.(), 0);
    const at = (ms: number, work: () => void) => setTimeout(work, ms);
    return {
      send: (frame: string | Uint8Array) => {
        if (typeof frame !== 'string') return;
        fake.starts.push(frame);
        if (talk === 'refused') {
          at(100, () => {
            listeners.onFrame(
              snapshot({
                error: {
                  code: 'voice_no_memory',
                  message: 'This machine does not have enough free memory to load speech right now.',
                },
              }),
            );
            listeners.onClose('speech failed on the machine', 1011);
          });
          return;
        }
        listeners.onFrame(snapshot({ state: 'loading' }));
        at(150, () => listeners.onFrame(snapshot({ state: 'listening' })));
        at(300, () =>
          listeners.onFrame(snapshot({ state: 'hearing', turn: 1, words: words('please check the build', false) })),
        );
        if (talk === 'hearing') return;
        at(2000, () => listeners.onFrame(snapshot({ state: 'working', turn: 1 })));
        at(2500, () =>
          listeners.onFrame(
            snapshot({
              state: 'listening',
              turn: 1,
              words: words('Please check the build and tell me what failed.', true),
              last: { turn: 1, outcome: 'heard' },
            }),
          ),
        );
      },
      close: (code?: number, reason?: string) => {
        fake.closed.push([code, reason]);
      },
    };
  },
};

const hear = params.get('hear') ?? 'ok';
const replySnapshot = (state: ReplyState, patch: Partial<StreamSnapshot> = {}, pcm = new Int16Array(0)): Uint8Array =>
  encodeReplyDownlinkUnit(
    { v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0, reply: state, ...patch },
    pcm,
  );

const hearClient = {
  socket: (
    _route: string,
    _params: unknown,
    listeners: {
      onOpen?: () => void;
      onFrame: (frame: Uint8Array) => void;
      onClose: (reason: string, code?: number) => void;
    },
  ) => {
    setTimeout(() => listeners.onOpen?.(), 0);
    return {
      send: (frame: string | Uint8Array) => {
        if (typeof frame !== 'string') return;
        if (frame.length < 1_024) {
          fake.hearStarts.push(frame);
          setTimeout(() => listeners.onFrame(replySnapshot('loading')), 50);
          setTimeout(() => listeners.onFrame(replySnapshot(hear === 'absent' ? 'absent' : 'ready')), 200);
          return;
        }
        fake.hearFrames.push(frame.trimEnd());
        if (hear === 'failed') {
          setTimeout(
            () =>
              listeners.onFrame(
                replySnapshot('ready', { audio: { id: 0, samples: 0, last: true, failed: 'reply_voice_failed' } }),
              ),
            200,
          );
          return;
        }
        // Three seconds-worth of sound would take too long to wait for: two slots and an ending are enough to see the page react.
        setTimeout(
          () =>
            listeners.onFrame(
              replySnapshot(
                'ready',
                { audio: { id: 0, samples: 3_200, last: false } },
                new Int16Array(3_200).fill(900),
              ),
            ),
          1_100,
        );
        setTimeout(
          () =>
            listeners.onFrame(
              replySnapshot('ready', { audio: { id: 0, samples: 800, last: true } }, new Int16Array(800).fill(900)),
            ),
          1_300,
        );
      },
      close: () => undefined,
    };
  },
};
const fakeDevice: SpeakerPort = {
  supported: true,
  voices: () => [],
  unlock: () => undefined,
  speak: request => {
    fake.deviceSpoke.push(request.segments.join(' '));
  },
  stop: () => undefined,
};
const fakePlayer: ReplyPlayer = {
  play: pcm => {
    fake.played += pcm.length;
  },
  position: () => undefined,
  stop: () => undefined,
  remainingMs: () => 0,
  close: () => {
    fake.playerClosed += 1;
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main className="fy-vs" style={{ boxSizing: 'border-box', padding: 16 }}>
      <VoiceModeSettings
        connection={daemonConnection({ daemonId: 'a', baseUrl: 'https://a.example.test', deviceId: 'd' })}
        createClient={async () => client as never}
        talk={{ client: talkClient as never, createMic: () => fakeMic }}
        hear={{
          client: hearClient as never,
          createMic: () => fakeMic,
          createPlayer: () => fakePlayer,
          device: fakeDevice,
        }}
      />
    </main>,
  );
