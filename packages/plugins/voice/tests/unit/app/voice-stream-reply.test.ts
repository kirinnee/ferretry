import { describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import {
  REPLY_AUDIO_SAMPLES,
  SPEAK_FRAME_BYTES,
  STREAM_CLOSES,
  type StreamSnapshot,
  decodeLineFrame,
  decodeSpeakFrame,
  encodeReplyDownlinkUnit,
  encodeDownlinkUnit,
} from '../../../contract/index.ts';
import { silentMic } from '../../../app/lib/stream/mic-source.ts';
import {
  type MicSource,
  openVoiceStream,
  type ReplyPlayer,
  type SpeechLineEvent,
} from '../../../app/lib/stream/voice-stream.ts';

const NONCE = 'bbbbbbbbbbbbbbbb';
const unit = (patch: Partial<StreamSnapshot>, pcm = new Int16Array(0)): Uint8Array =>
  encodeReplyDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, ...patch }, pcm);

function rig(options: { reply?: boolean } = {}) {
  const sent: (string | Uint8Array)[] = [];
  let listeners!: PluginSocketListeners;
  const played: Int16Array[] = [];
  let playerStops = 0;
  let clock = 1_000;
  const socket: PluginSocket = { send: frame => void sent.push(frame), close: () => undefined };
  const client = {
    socket: (_route: string, _params: unknown, given: PluginSocketListeners) => {
      listeners = given;
      return socket;
    },
  };
  const mic: MicSource = { start: async () => undefined, stop: () => undefined };
  const player: ReplyPlayer = {
    play: pcm => void played.push(pcm),
    stop: () => {
      playerStops += 1;
    },
    remainingMs: () => 0,
    close: () => undefined,
  };
  const events = {
    replies: [] as string[],
    lines: [] as SpeechLineEvent[],
    ended: [] as { code: number | undefined }[],
    protocolErrors: 0,
  };
  const handle = openVoiceStream(
    client,
    options.reply === false
      ? { t: 'start', v: 1, purpose: 'test' }
      : { t: 'start', v: 1, purpose: 'test', reply: 'machine' },
    mic,
    {
      onSnapshot: () => undefined,
      onWords: () => undefined,
      onEnded: ended => void events.ended.push(ended),
      onMicFailed: () => undefined,
      onReply: state => void events.replies.push(state),
      onSpeech: line => void events.lines.push(line),
    },
    { player, now: () => clock },
  );
  return {
    handle,
    events,
    sent,
    played,
    stops: () => playerStops,
    listeners: () => listeners,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('the browser end of the reply voice', () => {
  test('a stream that asks for it needs a player', () => {
    const client = { socket: () => ({ send: () => undefined, close: () => undefined }) };
    expect(() =>
      openVoiceStream(client, { t: 'start', v: 1, purpose: 'test', reply: 'machine' }, silentMic(), {
        onSnapshot: () => undefined,
        onWords: () => undefined,
        onEnded: () => undefined,
        onMicFailed: () => undefined,
      }),
    ).toThrow('needs a player');
  });

  test('speak sends one fixed-size frame per piece, with ids that count up, and says what it sent', () => {
    const r = rig();
    r.listeners().onOpen?.();
    const first = r.handle.speak('Let me check.');
    const second = r.handle.speak('Done.');
    expect(first).toEqual([{ id: 0, text: 'Let me check.' }]);
    expect(second).toEqual([{ id: 1, text: 'Done.' }]);
    const frames = r.sent.filter(
      (frame): frame is string => typeof frame === 'string' && frame.length === SPEAK_FRAME_BYTES,
    );
    expect(frames.map(frame => decodeSpeakFrame(frame))).toEqual([
      { t: 'speak', id: 0, text: 'Let me check.' },
      { t: 'speak', id: 1, text: 'Done.' },
    ]);
    const long = r.handle.speak('word '.repeat(600).trim());
    expect(long.length).toBeGreaterThan(1);
    expect(long.map(piece => piece.id)).toEqual(long.map((_, index) => 2 + index));
  });

  test('a stream that did not ask sends nothing for speak', () => {
    const r = rig({ reply: false });
    expect(r.handle.speak('Hello.')).toEqual([]);
  });

  test('the voice state is reported when it changes, and sound is played as it arrives', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.listeners().onFrame?.(unit({ reply: 'loading' }));
    r.listeners().onFrame?.(unit({ reply: 'loading' }));
    r.listeners().onFrame?.(unit({ reply: 'ready' }));
    expect(r.events.replies).toEqual(['loading', 'ready']);
    r.handle.speak('Hello.');
    r.advance(1_800);
    const pcm = new Int16Array(REPLY_AUDIO_SAMPLES).fill(7);
    r.listeners().onFrame?.(unit({ reply: 'ready', audio: { id: 0, samples: REPLY_AUDIO_SAMPLES, last: false } }, pcm));
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 0, samples: 100, last: true } }, new Int16Array(100).fill(3)),
    );
    expect(r.played.map(part => part.length)).toEqual([REPLY_AUDIO_SAMPLES, 100]);
    expect(r.events.lines).toEqual([
      { id: 0, event: 'started', firstSoundMs: 1_800 },
      { id: 0, event: 'finished' },
    ]);
  });

  test('a line the machine could not speak is reported failed with its code, even when no sound came', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.handle.speak('Hello.');
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 0, samples: 0, last: true, failed: 'reply_voice_failed' } }),
    );
    expect(r.events.lines).toEqual([{ id: 0, event: 'failed', code: 'reply_voice_failed' }]);
    expect(r.played).toHaveLength(0);
  });

  test('a sound for a line this browser never sent still plays and is reported, without a first-sound time', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.listeners().onFrame?.(unit({ audio: { id: 9, samples: 10, last: true } }, new Int16Array(10).fill(1)));
    expect(r.events.lines).toEqual([
      { id: 9, event: 'started' },
      { id: 9, event: 'finished' },
    ]);
  });

  test('a unit of the small size on a stream that asked for the larger is a protocol error that ends the stream', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.listeners().onFrame?.(encodeDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0 }));
    // A short unit is held until the rest of a unit arrives: it is the size, not the content, that is the contract.
    expect(r.events.ended).toHaveLength(0);
    r.listeners().onFrame?.(new Uint8Array(REPLY_AUDIO_SAMPLES * 2 + 1_024).fill(255));
    expect(r.events.ended).toEqual(
      [{ code: STREAM_CLOSES.protocol.code }].map(entry => expect.objectContaining(entry)),
    );
  });

  test('the sound stops the moment the stream ends, however it ends', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.handle.stop();
    expect(r.stops()).toBe(1);
    expect(r.handle.speak('late')).toEqual([]);
  });
});

describe('hush (barge-in) on the browser end', () => {
  test('silences the sound at once, tells the machine in one fixed-size frame, and ignores the sound of lines sent before it', () => {
    const r = rig();
    r.listeners().onOpen?.();
    r.handle.speak('First.');
    r.handle.speak('Second.');
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 0, samples: 100, last: false } }, new Int16Array(100).fill(5)),
    );
    expect(r.played).toHaveLength(1);
    r.handle.hush();
    expect(r.stops()).toBe(1);
    const frames = r.sent.filter(
      (frame): frame is string => typeof frame === 'string' && frame.length === SPEAK_FRAME_BYTES,
    );
    expect(decodeLineFrame(frames.at(-1) ?? '')).toEqual({ t: 'hush' });
    // Sound already on the wire for lines 0 and 1 is dropped, with no event for it.
    const events = r.events.lines.length;
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 0, samples: 100, last: true } }, new Int16Array(100).fill(5)),
    );
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 1, samples: 100, last: true } }, new Int16Array(100).fill(5)),
    );
    expect(r.played).toHaveLength(1);
    expect(r.events.lines).toHaveLength(events);
    // A line sent after the hush is heard as usual.
    const next = r.handle.speak('After.');
    expect(next).toEqual([{ id: 2, text: 'After.' }]);
    r.listeners().onFrame?.(
      unit({ reply: 'ready', audio: { id: 2, samples: 100, last: true } }, new Int16Array(100).fill(5)),
    );
    expect(r.played).toHaveLength(2);
  });

  test('a stream that did not ask for the reply voice sends nothing for a hush', () => {
    const r = rig({ reply: false });
    r.listeners().onOpen?.();
    const before = r.sent.length;
    r.handle.hush();
    expect(r.sent).toHaveLength(before);
  });
});

describe('what barge-in hears of the microphone', () => {
  test('every unit as it is sent, and zeros while muted', async () => {
    const sent: (string | Uint8Array)[] = [];
    let listeners!: PluginSocketListeners;
    let feed!: (pcm: Int16Array) => void;
    const heard: Int16Array[] = [];
    const client = {
      socket: (_route: string, _params: unknown, given: PluginSocketListeners) => {
        listeners = given;
        return { send: (frame: string | Uint8Array) => void sent.push(frame), close: () => undefined } as PluginSocket;
      },
    };
    const mic: MicSource = {
      start: async next => {
        feed = next;
      },
      stop: () => undefined,
    };
    const handle = openVoiceStream(
      client,
      { t: 'start', v: 1, purpose: 'chat', ferretId: 'f' },
      mic,
      {
        onSnapshot: () => undefined,
        onWords: () => undefined,
        onEnded: () => undefined,
        onMicFailed: () => undefined,
      },
      { onMicUnit: pcm => void heard.push(pcm) },
    );
    listeners.onOpen?.();
    await Promise.resolve();
    feed(new Int16Array(640).fill(9));
    handle.setMuted(true);
    feed(new Int16Array(640).fill(9));
    expect(heard.map(pcm => pcm[0])).toEqual([9, 0]);
  });
});

describe('the silent microphone', () => {
  test('sends a unit of zeros every 40 ms and stops when told', async () => {
    const units: Int16Array[] = [];
    const mic = silentMic();
    await mic.start(pcm => void units.push(pcm));
    await Bun.sleep(130);
    mic.stop();
    mic.stop();
    const count = units.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(units.every(pcm => pcm.length === 640 && pcm.every(sample => sample === 0))).toBe(true);
    await Bun.sleep(100);
    expect(units).toHaveLength(count);
  });
});
