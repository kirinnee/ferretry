import { describe, expect, test } from 'bun:test';
import {
  COUNTDOWN_MAX_MS,
  COUNTDOWN_STEP_MS,
  DEFAULT_LIVE_VOICE_SETTINGS,
  LIVE_VOICE_SETTINGS_KEY,
  LiveVoiceSettingsStore,
  MAX_VOICE_ID_CHARS,
  normaliseLiveVoiceSettings,
  PAUSE_OPTIONS,
  parseLiveVoiceSettings,
  READING_LENGTH_OPTIONS,
  readOptionsOf,
} from '../../src/lib/voice-chat/live-settings.ts';

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

describe('defaults', () => {
  test("Auto-read is OFF; rate 1.1; 60 seconds; the last message of the turn; the device's best voice; Live's own choices", () => {
    expect(DEFAULT_LIVE_VOICE_SETTINGS).toEqual({
      v: 2,
      autoRead: false,
      voiceId: null,
      rate: 1.1,
      maxSeconds: 60,
      whatToRead: 'last',
      earcons: true,
      // Live voice (slice 6): Normal pause, a 1.5 s countdown, read replies, screen on, tones and buzzes on.
      pause: 'normal',
      countdownMs: 1500,
      liveRead: true,
      keepAwake: true,
      haptics: true,
      screenReaderHintSeen: false,
    });
    expect(LIVE_VOICE_SETTINGS_KEY).toBe('fy-live-voice-v1');
  });
  test('the length picker runs from 30 seconds to no limit', () => {
    expect(READING_LENGTH_OPTIONS.map(option => option.seconds)).toEqual([30, 60, 120, 300, null]);
  });
});

describe('parseLiveVoiceSettings: defensive, capped, versioned', () => {
  test('null, garbage, the wrong shape and an unknown version all give the defaults', () => {
    expect(parseLiveVoiceSettings(null)).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings('{nope')).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings('[1]')).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings('"x"')).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 3, autoRead: true }))).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 0, autoRead: true }))).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    expect(parseLiveVoiceSettings(JSON.stringify({ autoRead: true }))).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
  });

  test('a good record round-trips', () => {
    const good = {
      v: 2,
      autoRead: true,
      voiceId: 'uri:Samantha',
      rate: 1.5,
      maxSeconds: 120,
      whatToRead: 'every',
      earcons: false,
      pause: 'thinker',
      countdownMs: 3000,
      liveRead: false,
      keepAwake: false,
      haptics: true,
      screenReaderHintSeen: true,
    } as const;
    expect(parseLiveVoiceSettings(JSON.stringify(good))).toEqual(good);
  });

  test('each bad field falls back by itself and the good ones are kept', () => {
    const parsed = parseLiveVoiceSettings(
      JSON.stringify({ v: 1, autoRead: 'yes', voiceId: 7, rate: 'fast', maxSeconds: 'long', whatToRead: 'all' }),
    );
    expect(parsed).toEqual(DEFAULT_LIVE_VOICE_SETTINGS);
    const mixed = parseLiveVoiceSettings(JSON.stringify({ v: 1, autoRead: true, rate: 'fast', whatToRead: 'every' }));
    expect(mixed.autoRead).toBe(true);
    expect(mixed.whatToRead).toBe('every');
    expect(mixed.rate).toBe(1.1);
  });

  test('rate is clamped to 0.8 – 2.0', () => {
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 1, rate: 9 })).rate).toBe(2);
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 1, rate: 0.1 })).rate).toBe(0.8);
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 1, rate: -4 })).rate).toBe(0.8);
  });

  test('max length: 30 s up to an hour, null is no limit, absent is a minute, out of range is a minute', () => {
    const seconds = (value: unknown) => parseLiveVoiceSettings(JSON.stringify({ v: 1, maxSeconds: value })).maxSeconds;
    expect(seconds(30)).toBe(30);
    expect(seconds(3600)).toBe(3600);
    expect(seconds(null)).toBeNull();
    expect(seconds(29)).toBe(60);
    expect(seconds(3601)).toBe(60);
    expect(seconds(45.5)).toBe(60);
    expect(parseLiveVoiceSettings(JSON.stringify({ v: 1 })).maxSeconds).toBe(60);
  });

  test('the voice id is capped and an empty one means the best voice', () => {
    const id = (value: unknown) => parseLiveVoiceSettings(JSON.stringify({ v: 1, voiceId: value })).voiceId;
    expect(id('x'.repeat(MAX_VOICE_ID_CHARS))).toBe('x'.repeat(MAX_VOICE_ID_CHARS));
    expect(id('x'.repeat(MAX_VOICE_ID_CHARS + 1))).toBeNull();
    expect(id('')).toBeNull();
    expect(id(null)).toBeNull();
  });

  test('unknown extra fields are dropped, so nothing hostile is carried along', () => {
    const parsed = parseLiveVoiceSettings(JSON.stringify({ v: 1, autoRead: true, token: 'secret', text: 'a reply' }));
    expect(Object.keys(parsed).sort()).toEqual([
      'autoRead',
      'countdownMs',
      'earcons',
      'haptics',
      'keepAwake',
      'liveRead',
      'maxSeconds',
      'pause',
      'rate',
      'screenReaderHintSeen',
      'v',
      'voiceId',
      'whatToRead',
    ]);
  });

  test('normalise clamps what a caller hands in', () => {
    expect(normaliseLiveVoiceSettings({ ...DEFAULT_LIVE_VOICE_SETTINGS, rate: 50 }).rate).toBe(2);
  });

  test('readOptionsOf is the voice, the rate and the length', () => {
    expect(readOptionsOf({ ...DEFAULT_LIVE_VOICE_SETTINGS, voiceId: 'v', rate: 1.3, maxSeconds: null })).toEqual({
      voiceId: 'v',
      rate: 1.3,
      maxSeconds: null,
    });
  });
});

describe('Live voice choices (slice 6)', () => {
  const parse = (fields: Record<string, unknown>) => parseLiveVoiceSettings(JSON.stringify({ v: 2, ...fields }));

  test('the pause is Quick, Normal or Thinker; anything else is Normal', () => {
    expect(PAUSE_OPTIONS.map(option => [option.id, option.seconds])).toEqual([
      ['quick', 0.9],
      ['normal', 1.5],
      ['thinker', 2.5],
    ]);
    expect(parse({ pause: 'quick' }).pause).toBe('quick');
    expect(parse({ pause: 'thinker' }).pause).toBe('thinker');
    expect(parse({ pause: 'slow' }).pause).toBe('normal');
    expect(parse({ pause: 1200 }).pause).toBe('normal');
  });

  test('the countdown is 0 to 5 s: clamped, rounded, garbage is the default 1.5 s, and 0 is kept', () => {
    expect(parse({ countdownMs: 0 }).countdownMs).toBe(0);
    expect(parse({ countdownMs: 2500 }).countdownMs).toBe(2500);
    expect(parse({ countdownMs: 5000 }).countdownMs).toBe(5000);
    expect(parse({ countdownMs: 99_999 }).countdownMs).toBe(5000);
    expect(parse({ countdownMs: -40 }).countdownMs).toBe(0);
    expect(parse({ countdownMs: 1200.4 }).countdownMs).toBe(1200);
    expect(parse({ countdownMs: 'long' }).countdownMs).toBe(1500);
    expect(parse({ countdownMs: Number.NaN }).countdownMs).toBe(1500);
    expect(COUNTDOWN_STEP_MS).toBe(500);
    expect(COUNTDOWN_MAX_MS).toBe(5000);
  });

  test('read in Live, keep screen on, buzz and the hint: booleans, each bad one falls back alone', () => {
    expect(parse({ liveRead: false }).liveRead).toBe(false);
    expect(parse({ liveRead: 'no' }).liveRead).toBe(true);
    expect(parse({ keepAwake: false }).keepAwake).toBe(false);
    expect(parse({ keepAwake: 0 }).keepAwake).toBe(true);
    expect(parse({ screenReaderHintSeen: true }).screenReaderHintSeen).toBe(true);
    expect(parse({ screenReaderHintSeen: 'yes' }).screenReaderHintSeen).toBe(false);
    expect(parse({ haptics: false, earcons: true }).haptics).toBe(false);
    expect(parse({ haptics: true, earcons: false }).haptics).toBe(true);
  });

  test('MIGRATION: a version-1 record is still read; the new fields default, and the buzz follows the old one switch', () => {
    const old = JSON.stringify({
      v: 1,
      autoRead: true,
      voiceId: 'uri:Daniel',
      rate: 1.3,
      maxSeconds: 120,
      whatToRead: 'every',
      earcons: true,
    });
    expect(parseLiveVoiceSettings(old)).toEqual({
      ...DEFAULT_LIVE_VOICE_SETTINGS,
      autoRead: true,
      voiceId: 'uri:Daniel',
      rate: 1.3,
      maxSeconds: 120,
      whatToRead: 'every',
    });
    // Someone who had switched the one Live-sounds switch off (tones AND buzzes) stays silent.
    const silent = parseLiveVoiceSettings(JSON.stringify({ v: 1, earcons: false }));
    expect(silent.earcons).toBe(false);
    expect(silent.haptics).toBe(false);
    // The next write is version 2 and keeps what was there.
    const storage = memory({ [LIVE_VOICE_SETTINGS_KEY]: JSON.stringify({ v: 1, earcons: false, rate: 1.7 }) });
    const store = new LiveVoiceSettingsStore(storage);
    store.update({ pause: 'quick' });
    expect(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({
      v: 2,
      earcons: false,
      haptics: false,
      rate: 1.7,
      pause: 'quick',
      countdownMs: 1500,
    });
  });

  test('an out-of-range countdown patch is normalised before it is stored', () => {
    const store = new LiveVoiceSettingsStore(memory());
    store.update({ countdownMs: 60_000 });
    expect(store.get().countdownMs).toBe(5000);
  });
});

describe('LiveVoiceSettingsStore', () => {
  test('starts from storage, writes through, and tells subscribers once per real change', () => {
    const storage = memory({ [LIVE_VOICE_SETTINGS_KEY]: JSON.stringify({ v: 1, autoRead: true }) });
    const store = new LiveVoiceSettingsStore(storage);
    expect(store.get().autoRead).toBe(true);
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    const before = store.get();
    store.update({ rate: 1.6 });
    expect(calls).toBe(1);
    expect(store.get()).not.toBe(before);
    expect(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ v: 2, rate: 1.6 });
    // A patch that changes nothing keeps the snapshot and tells nobody.
    const same = store.get();
    store.update({ rate: 1.6 });
    expect(store.get()).toBe(same);
    expect(calls).toBe(1);
    off();
    store.update({ rate: 1.2 });
    expect(calls).toBe(1);
  });

  test('an out-of-range patch is normalised before it is stored', () => {
    const storage = memory();
    const store = new LiveVoiceSettingsStore(storage);
    store.update({ rate: 99, maxSeconds: 5 });
    expect(store.get().rate).toBe(2);
    expect(store.get().maxSeconds).toBe(60);
  });

  test('storage that throws or is absent is a normal path: the choice holds in memory and persisted says false', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const store = new LiveVoiceSettingsStore(throwing);
    expect(store.get()).toBe(DEFAULT_LIVE_VOICE_SETTINGS);
    store.update({ autoRead: true });
    expect(store.get().autoRead).toBe(true);
    expect(store.persisted).toBe(false);
    expect(store.reload().autoRead).toBe(true);
    const none = new LiveVoiceSettingsStore(null);
    none.update({ autoRead: true });
    expect(none.persisted).toBe(false);
    expect(none.reload().autoRead).toBe(true);
  });

  test("reload picks up another tab's write, and publishes only when something changed", () => {
    const storage = memory();
    const store = new LiveVoiceSettingsStore(storage);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.reload();
    expect(calls).toBe(0);
    storage.data.set(LIVE_VOICE_SETTINGS_KEY, JSON.stringify({ v: 1, autoRead: true, whatToRead: 'every' }));
    expect(store.reload()).toMatchObject({ autoRead: true, whatToRead: 'every' });
    expect(calls).toBe(1);
  });

  test('a successful write after a refused one reports persisted again', () => {
    let fail = true;
    const storage = {
      getItem: () => null,
      setItem: () => {
        if (fail) throw new Error('quota');
      },
    };
    const store = new LiveVoiceSettingsStore(storage);
    store.update({ autoRead: true });
    expect(store.persisted).toBe(false);
    fail = false;
    store.update({ autoRead: false });
    expect(store.persisted).toBe(true);
  });
});
