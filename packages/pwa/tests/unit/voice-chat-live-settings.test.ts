import { describe, expect, test } from 'bun:test';
import {
  COUNTDOWN_MAX_MS,
  COUNTDOWN_STEP_MS,
  DEFAULT_LIVE_VOICE_SETTINGS,
  graceMsOf,
  LIVE_VOICE_EXTRAS_KEY,
  LIVE_VOICE_SETTINGS_KEY,
  LiveVoiceSettingsStore,
  MAX_VOICE_ID_CHARS,
  normaliseLiveVoiceSettings,
  PAUSE_OPTIONS,
  parseLiveVoiceSettings,
  READING_LENGTH_OPTIONS,
  readOptionsOf,
  serialiseLiveVoiceSettings,
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
      // "Send without a countdown" is a deliberate choice: OFF until the person switches it on.
      sendWithoutCountdown: false,
      liveRead: true,
      keepAwake: true,
      haptics: true,
      screenReaderHintSeen: false,
    });
    expect(LIVE_VOICE_SETTINGS_KEY).toBe('fy-live-voice-v1');
    expect(LIVE_VOICE_EXTRAS_KEY).toBe('fy-live-voice-extras-v1');
  });
  test('the length picker runs from 30 seconds to no limit', () => {
    expect(READING_LENGTH_OPTIONS.map(option => option.seconds)).toEqual([30, 60, 120, 300, null]);
  });
});

describe('parseLiveVoiceSettings: defensive, capped, versioned', () => {
  test('null, garbage, the wrong shape and an unknown version all give the defaults, in either record', () => {
    const defaults = DEFAULT_LIVE_VOICE_SETTINGS;
    expect(parseLiveVoiceSettings(null)).toEqual(defaults);
    for (const bad of [
      '{nope',
      '[1]',
      '"x"',
      JSON.stringify({ v: 3, autoRead: true, pause: 'quick' }),
      JSON.stringify({ v: 0, autoRead: true, pause: 'quick' }),
      JSON.stringify({ v: 2, autoRead: true, pause: 'quick' }),
      JSON.stringify({ autoRead: true, pause: 'quick' }),
    ]) {
      expect(parseLiveVoiceSettings(bad)).toEqual(defaults);
      expect(parseLiveVoiceSettings(null, bad)).toEqual(defaults);
    }
  });

  test('a bad record costs only its own fields: an unreadable extras record leaves the version-1 fields alone, and the other way round', () => {
    const shared = JSON.stringify({ v: 1, autoRead: true, rate: 1.4 });
    const extras = JSON.stringify({ v: 1, pause: 'quick', liveRead: false });
    expect(parseLiveVoiceSettings(shared, '{nope')).toMatchObject({
      autoRead: true,
      rate: 1.4,
      pause: 'normal',
      liveRead: true,
    });
    expect(parseLiveVoiceSettings('{nope', extras)).toMatchObject({
      autoRead: false,
      rate: 1.1,
      pause: 'quick',
      liveRead: false,
    });
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
      sendWithoutCountdown: true,
      liveRead: false,
      keepAwake: false,
      haptics: true,
      screenReaderHintSeen: true,
    } as const;
    const { shared, extras } = serialiseLiveVoiceSettings(good);
    expect(parseLiveVoiceSettings(shared, extras)).toEqual(good);
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
    const parsed = parseLiveVoiceSettings(
      JSON.stringify({ v: 1, autoRead: true, token: 'secret', text: 'a reply' }),
      JSON.stringify({ v: 1, pause: 'quick', password: 'secret' }),
    );
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
      'sendWithoutCountdown',
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
  /** Slice 6's own record, as stored under `fy-live-voice-extras-v1`. */
  const parse = (fields: Record<string, unknown>) => parseLiveVoiceSettings(null, JSON.stringify({ v: 1, ...fields }));

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

  test('the countdown is 0.5 to 5 s: clamped, rounded, garbage is the default 1.5 s', () => {
    expect(parse({ countdownMs: 500 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: 2500 }).countdownMs).toBe(2500);
    expect(parse({ countdownMs: 5000 }).countdownMs).toBe(5000);
    expect(parse({ countdownMs: 99_999 }).countdownMs).toBe(5000);
    expect(parse({ countdownMs: 1200.4 }).countdownMs).toBe(1200);
    expect(parse({ countdownMs: 'long' }).countdownMs).toBe(1500);
    expect(parse({ countdownMs: Number.NaN }).countdownMs).toBe(1500);
    expect(COUNTDOWN_STEP_MS).toBe(500);
    expect(COUNTDOWN_MAX_MS).toBe(5000);
  });

  test('SAFEGUARD: no damaged countdown ever means "send at once" — negative, fractional, zero, NaN, string, huge', () => {
    for (const bad of [
      -40,
      -0.1,
      -1_000_000,
      0.1,
      0.4,
      1,
      499,
      0,
      -0,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      '0',
      '-40',
      '',
      null,
      true,
      [],
      {},
    ]) {
      const settings = parse({ countdownMs: bad });
      expect(settings.countdownMs).toBeGreaterThanOrEqual(500);
      expect(settings.sendWithoutCountdown).toBe(false);
      expect(graceMsOf(settings)).toBeGreaterThanOrEqual(500);
    }
    // Where there is a safe nearest value it is used: small and negative numbers go UP to the 0.5 s floor, huge ones down to 5 s.
    expect(parse({ countdownMs: -40 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: -0.1 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: 0.1 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: 0 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: 499 }).countdownMs).toBe(500);
    expect(parse({ countdownMs: 1e12 }).countdownMs).toBe(5000);
    // A number that is not a number at all is the default.
    expect(parse({ countdownMs: '0' }).countdownMs).toBe(1500);
    expect(parse({ countdownMs: null }).countdownMs).toBe(1500);
    // The same through a version-2 snapshot that arrives with a corrupted countdown (the report: {v:2,countdownMs:-40}).
    expect(parseLiveVoiceSettings(null, JSON.stringify({ v: 2, countdownMs: -40 })).countdownMs).toBe(1500);
    expect(graceMsOf(parseLiveVoiceSettings(null, JSON.stringify({ v: 1, countdownMs: -40 })))).toBe(500);
  });

  test('"Send without a countdown" is only ever an exact true; everything else is off, and then the countdown is used', () => {
    expect(parse({ sendWithoutCountdown: true }).sendWithoutCountdown).toBe(true);
    expect(graceMsOf(parse({ sendWithoutCountdown: true, countdownMs: 3000 }))).toBe(0);
    for (const notTrue of [false, 'true', 'yes', 1, 0, null, [], {}, undefined]) {
      expect(parse({ sendWithoutCountdown: notTrue }).sendWithoutCountdown).toBe(false);
    }
    expect(graceMsOf(parse({ sendWithoutCountdown: 'true', countdownMs: 3000 }))).toBe(3000);
    // The countdown is kept while the switch is on, so switching it off brings the old countdown back.
    const store = new LiveVoiceSettingsStore(memory());
    store.update({ countdownMs: 3500 });
    store.update({ sendWithoutCountdown: true });
    expect(store.get().countdownMs).toBe(3500);
    expect(graceMsOf(store.get())).toBe(0);
    store.update({ sendWithoutCountdown: false });
    expect(graceMsOf(store.get())).toBe(3500);
  });

  test('read in Live, keep screen on, buzz and the hint: booleans, each bad one falls back alone', () => {
    expect(parse({ liveRead: false }).liveRead).toBe(false);
    expect(parse({ liveRead: 'no' }).liveRead).toBe(true);
    expect(parse({ keepAwake: false }).keepAwake).toBe(false);
    expect(parse({ keepAwake: 0 }).keepAwake).toBe(true);
    expect(parse({ screenReaderHintSeen: true }).screenReaderHintSeen).toBe(true);
    expect(parse({ screenReaderHintSeen: 'yes' }).screenReaderHintSeen).toBe(false);
    const withEarcons = (earcons: boolean, haptics: unknown) =>
      parseLiveVoiceSettings(JSON.stringify({ v: 1, earcons }), JSON.stringify({ v: 1, haptics }));
    expect(withEarcons(true, false).haptics).toBe(false);
    expect(withEarcons(false, true).haptics).toBe(true);
    // No (or a bad) buzz choice follows the one sounds switch an older record had.
    expect(withEarcons(false, undefined).haptics).toBe(false);
    expect(withEarcons(true, 'loud').haptics).toBe(true);
  });

  test('MIGRATION: a version-1 record alone is still read; the new fields default, and the buzz follows the old one switch', () => {
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
    // The next write keeps what was there and puts the new fields in their own record.
    const storage = memory({ [LIVE_VOICE_SETTINGS_KEY]: JSON.stringify({ v: 1, earcons: false, rate: 1.7 }) });
    const store = new LiveVoiceSettingsStore(storage);
    store.update({ pause: 'quick' });
    expect(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).toEqual({
      v: 1,
      autoRead: false,
      voiceId: null,
      rate: 1.7,
      maxSeconds: 60,
      whatToRead: 'last',
      earcons: false,
    });
    expect(JSON.parse(storage.data.get(LIVE_VOICE_EXTRAS_KEY) ?? '{}')).toEqual({
      v: 1,
      pause: 'quick',
      countdownMs: 1500,
      sendWithoutCountdown: false,
      liveRead: true,
      keepAwake: true,
      haptics: false,
      screenReaderHintSeen: false,
    });
  });

  test('an out-of-range countdown patch is normalised before it is stored, and a patch of 0 is not "no countdown"', () => {
    const store = new LiveVoiceSettingsStore(memory());
    store.update({ countdownMs: 60_000 });
    expect(store.get().countdownMs).toBe(5000);
    store.update({ countdownMs: 0 });
    expect(store.get().countdownMs).toBe(500);
    expect(store.get().sendWithoutCountdown).toBe(false);
    store.update({ countdownMs: -40 });
    expect(store.get().countdownMs).toBe(500);
    expect(graceMsOf(store.get())).toBe(500);
  });
});

/**
 * Mixed versions in one browser: slice 5's tab (an "old" client) reads `fy-live-voice-v1` only when `v` is 1 and
 * rewrites that whole record on every change; slice 6's tab (the new one) keeps its own fields in a second record.
 * The old client here is a faithful copy of slice 5's logic, so these tests fail if the new client ever puts
 * something an old tab cannot read, or can erase, in the old record.
 */
describe('mixed versions in one browser (an older tab and a newer tab)', () => {
  const OLD_DEFAULTS = {
    v: 1,
    autoRead: false,
    voiceId: null,
    rate: 1.1,
    maxSeconds: 60,
    whatToRead: 'last',
    earcons: true,
  };
  const oldClient = (storage: ReturnType<typeof memory>) => ({
    read: (): Record<string, unknown> => {
      const raw = storage.getItem(LIVE_VOICE_SETTINGS_KEY);
      if (raw === null) return OLD_DEFAULTS;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed['v'] === 1 ? { ...OLD_DEFAULTS, ...parsed } : OLD_DEFAULTS;
    },
    // Slice 5's write: its six fields, the whole record, replacing whatever was there.
    write(patch: Record<string, unknown>) {
      const next: Record<string, unknown> = { ...this.read(), ...patch, v: 1 };
      const kept = ['v', 'autoRead', 'voiceId', 'rate', 'maxSeconds', 'whatToRead', 'earcons'];
      storage.setItem(LIVE_VOICE_SETTINGS_KEY, JSON.stringify(Object.fromEntries(kept.map(key => [key, next[key]]))));
    },
  });

  test('NEW writes, OLD reads: the older tab still sees every version-1 choice (not defaults)', () => {
    const storage = memory();
    const fresh = new LiveVoiceSettingsStore(storage);
    fresh.update({
      autoRead: true,
      voiceId: 'uri:Daniel',
      rate: 1.6,
      whatToRead: 'every',
      earcons: false,
      pause: 'thinker',
      liveRead: false,
    });
    expect(oldClient(storage).read()).toEqual({
      v: 1,
      autoRead: true,
      voiceId: 'uri:Daniel',
      rate: 1.6,
      maxSeconds: 60,
      whatToRead: 'every',
      earcons: false,
    });
  });

  test("OLD writes, NEW reads: an older tab's save does not erase a single Live field", () => {
    const storage = memory();
    const fresh = new LiveVoiceSettingsStore(storage);
    fresh.update({
      pause: 'thinker',
      countdownMs: 3500,
      sendWithoutCountdown: true,
      liveRead: false,
      keepAwake: false,
      haptics: false,
      screenReaderHintSeen: true,
    });
    oldClient(storage).write({ rate: 1.9, whatToRead: 'every' });
    const after = fresh.reload();
    expect(after).toMatchObject({
      rate: 1.9,
      whatToRead: 'every',
      pause: 'thinker',
      countdownMs: 3500,
      sendWithoutCountdown: true,
      liveRead: false,
      keepAwake: false,
      haptics: false,
      screenReaderHintSeen: true,
    });
    // A tab that starts after the old tab's save sees the same.
    expect(new LiveVoiceSettingsStore(storage).get()).toEqual(after);
  });

  test('both directions, interleaved: each side keeps its own fields and the shared ones follow the newest write', () => {
    const storage = memory();
    const old = oldClient(storage);
    old.write({ autoRead: true, earcons: false });
    const fresh = new LiveVoiceSettingsStore(storage);
    expect(fresh.get()).toMatchObject({ autoRead: true, earcons: false, haptics: false, pause: 'normal' });
    fresh.update({ pause: 'quick', haptics: true });
    old.write({ earcons: true });
    expect(fresh.reload()).toMatchObject({ autoRead: true, earcons: true, pause: 'quick', haptics: true });
    fresh.update({ voiceId: 'uri:X' });
    expect(old.read()).toMatchObject({ autoRead: true, earcons: true, voiceId: 'uri:X' });
  });

  test('the version-1 record is exactly the six fields an older build parses, whatever the new client holds', () => {
    const storage = memory();
    new LiveVoiceSettingsStore(storage).update({
      pause: 'quick',
      countdownMs: 4000,
      sendWithoutCountdown: true,
      haptics: false,
    });
    expect(Object.keys(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).sort()).toEqual(
      ['autoRead', 'earcons', 'maxSeconds', 'rate', 'v', 'voiceId', 'whatToRead'].sort(),
    );
    expect(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}').v).toBe(1);
  });

  test('a refused write to one record still writes the other, and persisted says false', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === LIVE_VOICE_EXTRAS_KEY) throw new Error('quota');
        data.set(key, value);
      },
    };
    const store = new LiveVoiceSettingsStore(storage);
    store.update({ rate: 1.5 });
    expect(store.persisted).toBe(false);
    expect(JSON.parse(data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ rate: 1.5 });
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
    expect(JSON.parse(storage.data.get(LIVE_VOICE_SETTINGS_KEY) ?? '{}')).toMatchObject({ v: 1, rate: 1.6 });
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
    storage.data.set(LIVE_VOICE_EXTRAS_KEY, JSON.stringify({ v: 1, pause: 'quick' }));
    expect(store.reload()).toMatchObject({ autoRead: true, pause: 'quick' });
    expect(calls).toBe(2);
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
