/**
 * A FAKE MACHINE for the first-run Voice step's voice-mode setup: the speech engine and the reply voice it installs, a
 * Talk to test socket, and a "Hear it" socket. It is a server in the test's sense: the page code under test is real and
 * talks to it through the same `client.request` and `socket` seams the shell hands the plugin. No audio and no secret exists
 * here; every call is recorded on `fake` (the scene puts it on `window.__fake`).
 *
 * `machine(params)` reads, from the page's query:
 *   &engine=not_installed|installing|ready|failed   the speech engine's state on arrival (default not_installed)
 *   &reply=not_installed|installing|ready|failed    the reply voice's (default not_installed)
 *   &talk=heard|hearing|refused                     what the machine says to Talk to test (default heard)
 * An install starts the download; every read after it moves 35 % (engine) or 50 % (reply voice) further until Ready.
 */
import {
  encodeDownlinkUnit,
  encodeReplyDownlinkUnit,
  type ReplyState,
  type StreamSnapshot,
} from '../../../../contract/index.ts';
import type { MicSource, ReplyPlayer } from '../../../../app/lib/stream/voice-stream.ts';
import type { SpeakerPort } from '../../../../app/lib/voice-chat/ports.ts';

type State = 'not_installed' | 'installing' | 'ready' | 'failed';

export interface FakeLog {
  installs: number;
  replyInstalls: number;
  reads: string[];
  starts: string[];
  closed: unknown[];
  micStopped: number;
  hearStarts: number;
}

const ENGINE_BYTES = 698_905_830;
const REPLY_BYTES = 164_022_376;

interface Listeners {
  onOpen?: () => void;
  onFrame: (frame: Uint8Array) => void;
  onClose: (reason: string, code?: number) => void;
}

export function machine(params: URLSearchParams) {
  const fake: FakeLog = {
    installs: 0,
    replyInstalls: 0,
    reads: [],
    starts: [],
    closed: [],
    micStopped: 0,
    hearStarts: 0,
  };
  let engine = (params.get('engine') ?? 'not_installed') as State;
  let engineDone = engine === 'ready' ? ENGINE_BYTES : 0;
  let reply = (params.get('reply') ?? 'not_installed') as State;
  let replyDone = reply === 'ready' ? REPLY_BYTES : 0;
  const talk = params.get('talk') ?? 'heard';

  const engineView = () => ({
    state: engine,
    machine: 'Studio Mac',
    label: 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection',
    sizeBytes: ENGINE_BYTES,
    doneBytes: engineDone,
    loaded: false,
    ...(engine === 'failed'
      ? {
          failure: {
            code: 'download_failed',
            sentence: 'The speech files could not be downloaded. Check this machine’s internet and try again.',
          },
        }
      : {}),
    ...(engine === 'ready' ? { selfTest: { loadMs: 1865, decodeMs: 650, memoryMb: 819 } } : {}),
  });
  const replyView = () => ({
    state: reply,
    machine: 'Studio Mac',
    label: 'Kokoro 82M (int8), a natural English reply voice',
    sizeBytes: REPLY_BYTES,
    doneBytes: replyDone,
    loaded: false,
    ...(reply === 'ready'
      ? { selfTest: { loadMs: 1765, speakMs: 5163, audioMs: 1618, realTimeFactor: 3.19, memoryMb: 512 } }
      : {}),
  });

  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      fake.reads.push(`${method} ${path}`);
      if (path.startsWith('/v1/voice/reply-voice')) {
        if (method === 'POST') {
          fake.replyInstalls += 1;
          reply = 'installing';
          replyDone = 0;
        } else if (reply === 'installing') {
          replyDone = Math.min(REPLY_BYTES, replyDone + Math.round(REPLY_BYTES * 0.5));
          if (replyDone >= REPLY_BYTES) reply = 'ready';
        }
        return schema.parse(replyView());
      }
      if (path.startsWith('/v1/voice/engine')) {
        if (method === 'POST') {
          fake.installs += 1;
          engine = 'installing';
          engineDone = 0;
        } else if (engine === 'installing') {
          engineDone = Math.min(ENGINE_BYTES, engineDone + Math.round(ENGINE_BYTES * 0.35));
          if (engineDone >= ENGINE_BYTES) engine = 'ready';
        }
        return schema.parse(engineView());
      }
      throw new Error(`the fake machine has no ${path}`);
    },
  };

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

  const mic: MicSource = {
    start: async onUnit => {
      const timer = setInterval(() => onUnit(new Int16Array(640)), 40);
      mic.stop = () => {
        fake.micStopped += 1;
        clearInterval(timer);
      };
    },
    stop: () => undefined,
  };

  const talkClient = {
    socket: (_route: string, _params: unknown, listeners: Listeners) => {
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
        close: (code?: number, reason?: string) => void fake.closed.push([code, reason]),
      };
    },
  };

  const replySnapshot = (state: ReplyState, patch: Partial<StreamSnapshot> = {}, pcm = new Int16Array(0)): Uint8Array =>
    encodeReplyDownlinkUnit(
      { v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0, reply: state, ...patch },
      pcm,
    );
  const hearClient = {
    socket: (_route: string, _params: unknown, listeners: Listeners) => {
      setTimeout(() => listeners.onOpen?.(), 0);
      return {
        send: (frame: string | Uint8Array) => {
          if (typeof frame !== 'string') return;
          if (frame.length < 1_024) {
            fake.hearStarts += 1;
            setTimeout(() => listeners.onFrame(replySnapshot('ready')), 100);
            return;
          }
          setTimeout(
            () =>
              listeners.onFrame(
                replySnapshot('ready', { audio: { id: 0, samples: 800, last: true } }, new Int16Array(800).fill(900)),
              ),
            300,
          );
        },
        close: () => undefined,
      };
    },
  };
  const device: SpeakerPort = {
    supported: true,
    voices: () => [],
    unlock: () => undefined,
    speak: () => undefined,
    stop: () => undefined,
  };
  const player: ReplyPlayer = {
    play: () => undefined,
    stop: () => undefined,
    remainingMs: () => 0,
    close: () => undefined,
  };

  return {
    fake,
    createClient: async () => client as never,
    talk: { client: talkClient as never, createMic: () => mic },
    hear: { client: hearClient as never, createMic: () => mic, createPlayer: () => player, device },
  };
}
