import { describe, it } from 'bun:test';
import should from 'should';
import { DEFAULT_DICTATION_SHORTCUT } from '../../../src/features/settings/dictation-shortcut.ts';
import {
  DEFAULT_GROQ_ENHANCEMENT_MODEL,
  DEFAULT_STT_SETTINGS,
  ENHANCEMENT_PROVIDERS,
  MAX_DICTIONARY_LINE_LENGTH,
  MAX_DICTIONARY_LINES,
  MAX_ENHANCEMENT_MODEL_CHARS,
  MAX_USER_CONTEXT_CHARS,
  normaliseSttSettings,
  parseDictationShortcut,
  parseSttSettings,
  STT_SETTINGS_KEY,
  STT_SETTINGS_VERSION,
  sttDictionary,
  type SttSettings,
  type SttSettingsStorage,
  SttSettingsStore,
} from '../../../src/lib/stt/stt-settings.ts';

/** Records every write so a refusal and a no-op can each be proved. */
class MemoryStorage implements SttSettingsStorage {
  readonly writes: string[] = [];
  #value: string | null;
  #refuse: boolean;

  constructor(value: string | null = null, refuse = false) {
    this.#value = value;
    this.#refuse = refuse;
  }

  getItem(): string | null {
    return this.#value;
  }

  setItem(_key: string, value: string): void {
    if (this.#refuse) throw new Error('quota exceeded');
    this.writes.push(value);
    this.#value = value;
  }

  /** Simulates another tab writing under our key. */
  poke(value: string | null): void {
    this.#value = value;
  }
}

class BlockedStorage implements SttSettingsStorage {
  getItem(): string | null {
    throw new Error('storage is disabled');
  }

  setItem(): void {
    throw new Error('storage is disabled');
  }
}

const stored = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: STT_SETTINGS_VERSION, ...overrides });

describe('parseDictationShortcut', () => {
  it('reads a persisted chord back in canonical modifier order', () => {
    const binding = parseDictationShortcut({ code: 'KeyD', key: 'd', modifiers: ['Shift', 'Meta'] });
    should(binding).deepEqual({ code: 'KeyD', key: 'd', modifiers: ['Meta', 'Shift'] });
  });

  it('drops a modifier that is not part of the vocabulary', () => {
    const binding = parseDictationShortcut({ code: 'KeyD', key: 'd', modifiers: ['Hyper', 'Alt'] });
    should(binding.modifiers).deepEqual(['Alt']);
  });

  it('falls back to the default for anything unusable', () => {
    should(parseDictationShortcut(null)).equal(DEFAULT_DICTATION_SHORTCUT);
    should(parseDictationShortcut('Alt')).equal(DEFAULT_DICTATION_SHORTCUT);
    should(parseDictationShortcut([])).equal(DEFAULT_DICTATION_SHORTCUT);
    should(parseDictationShortcut({ key: 'd' })).equal(DEFAULT_DICTATION_SHORTCUT);
    should(parseDictationShortcut({ code: 'KeyD' })).equal(DEFAULT_DICTATION_SHORTCUT);
  });

  it('caps a hostile code or key rather than storing it whole', () => {
    const binding = parseDictationShortcut({ code: 'c'.repeat(200), key: 'k'.repeat(200), modifiers: [] });
    should(binding.code).have.length(48);
    should(binding.key).have.length(24);
  });

  it('tolerates a modifiers field that is not an array', () => {
    should(parseDictationShortcut({ code: 'KeyD', key: 'd', modifiers: 'Alt' }).modifiers).deepEqual([]);
  });
});

describe('parseSttSettings', () => {
  it('defaults to dictation on, on-device enhancement and a bare Alt chord', () => {
    should(parseSttSettings(null)).deepEqual(DEFAULT_STT_SETTINGS);
    should(DEFAULT_STT_SETTINGS.enabled).be.true();
    should(DEFAULT_STT_SETTINGS.enhancementProvider).equal('local');
    should(DEFAULT_STT_SETTINGS.enhancementModel).equal(DEFAULT_GROQ_ENHANCEMENT_MODEL);
    should(DEFAULT_STT_SETTINGS.shortcut).equal(DEFAULT_DICTATION_SHORTCUT);
  });

  it('reads a well-formed payload back', () => {
    const settings = parseSttSettings(
      stored({
        enabled: false,
        enhancement: false,
        dictionary: ['kteam = kteem'],
        userContext: 'jargon',
        enhancementProvider: 'groq',
        enhancementModel: ' llama-3.3 ',
        shortcut: { code: 'KeyD', key: 'd', modifiers: ['Alt'] },
      }),
    );

    should(settings).deepEqual({
      v: STT_SETTINGS_VERSION,
      enabled: false,
      enhancement: false,
      dictionary: ['kteam = kteem'],
      userContext: 'jargon',
      enhancementProvider: 'groq',
      enhancementModel: 'llama-3.3',
      shortcut: { code: 'KeyD', key: 'd', modifiers: ['Alt'] },
    });
  });

  it('resets on a version this build has never seen, rather than half-reading it', () => {
    should(parseSttSettings(JSON.stringify({ v: 4, enabled: false }))).deepEqual(DEFAULT_STT_SETTINGS);
    should(parseSttSettings(JSON.stringify({ enabled: false }))).deepEqual(DEFAULT_STT_SETTINGS);
  });

  it('never throws on a hostile payload', () => {
    should(parseSttSettings('{ not json')).deepEqual(DEFAULT_STT_SETTINGS);
    should(parseSttSettings('[]')).deepEqual(DEFAULT_STT_SETTINGS);
    should(parseSttSettings('7')).deepEqual(DEFAULT_STT_SETTINGS);
  });

  it('degrades one bad field without discarding the rest', () => {
    const settings = parseSttSettings(
      stored({ enabled: 'yes', enhancement: 1, dictionary: 'nope', userContext: 42, enhancementProvider: 'openai' }),
    );

    should(settings.enabled).be.true();
    should(settings.enhancement).be.true();
    should(settings.dictionary).deepEqual([]);
    should(settings.userContext).equal('');
    should(settings.enhancementProvider).equal('local');
  });

  it('caps the dictionary by line count and line length', () => {
    const lines = Array.from({ length: MAX_DICTIONARY_LINES + 5 }, () => 'x'.repeat(MAX_DICTIONARY_LINE_LENGTH + 20));
    const settings = parseSttSettings(stored({ dictionary: [...lines, 7] }));

    should(settings.dictionary).have.length(MAX_DICTIONARY_LINES);
    should(settings.dictionary[0]).have.length(MAX_DICTIONARY_LINE_LENGTH);
  });

  it('skips a non-string dictionary line without losing the ones around it', () => {
    should(parseSttSettings(stored({ dictionary: ['a', 5, 'b'] })).dictionary).deepEqual(['a', 'b']);
  });

  it('caps the free-text context and the model id', () => {
    const settings = parseSttSettings(
      stored({ userContext: 'z'.repeat(MAX_USER_CONTEXT_CHARS + 10), enhancementModel: 'm'.repeat(400) }),
    );

    should(settings.userContext).have.length(MAX_USER_CONTEXT_CHARS);
    should(settings.enhancementModel).have.length(MAX_ENHANCEMENT_MODEL_CHARS);
  });

  it('treats a blank model id as no choice at all', () => {
    should(parseSttSettings(stored({ enhancementModel: '   ' })).enhancementModel).equal(
      DEFAULT_GROQ_ENHANCEMENT_MODEL,
    );
  });

  it('accepts every declared provider and nothing else', () => {
    for (const provider of ENHANCEMENT_PROVIDERS) {
      should(parseSttSettings(stored({ enhancementProvider: provider.id })).enhancementProvider).equal(provider.id);
    }
  });
});

describe('normaliseSttSettings', () => {
  it('refuses to let a caller persist an out-of-range shape', () => {
    const hostile = {
      ...DEFAULT_STT_SETTINGS,
      enhancementModel: 'm'.repeat(400),
      userContext: 'z'.repeat(MAX_USER_CONTEXT_CHARS + 1),
    } as SttSettings;

    const normalised = normaliseSttSettings(hostile);
    should(normalised.enhancementModel).have.length(MAX_ENHANCEMENT_MODEL_CHARS);
    should(normalised.userContext).have.length(MAX_USER_CONTEXT_CHARS);
  });
});

describe('SttSettingsStore', () => {
  it('loads what storage holds and keeps the snapshot identity stable', () => {
    const store = new SttSettingsStore(new MemoryStorage(stored({ enabled: false })));
    should(store.get().enabled).be.false();
    should(store.get()).equal(store.get());
  });

  it('starts from the defaults when there is no storage at all', () => {
    should(new SttSettingsStore().get()).deepEqual(DEFAULT_STT_SETTINGS);
  });

  it('survives a browser that refuses even to hand over storage', () => {
    const store = new SttSettingsStore(new BlockedStorage());
    should(store.get()).deepEqual(DEFAULT_STT_SETTINGS);
    store.update({ enabled: false });
    should(store.get().enabled).be.false();
    should(store.persisted).be.false();
  });

  it('applies a patch, writes it, and leaves the other fields alone', () => {
    const storage = new MemoryStorage();
    const store = new SttSettingsStore(storage);

    const next = store.update({ enhancement: false });
    should(next.enhancement).be.false();
    should(next.enabled).be.true();
    should(store.persisted).be.true();
    should(JSON.parse(storage.writes[0] as string)).have.property('enhancement', false);
  });

  it('normalises a patch on the way in', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    should(store.update({ enhancementModel: 'm'.repeat(400) }).enhancementModel).have.length(
      MAX_ENHANCEMENT_MODEL_CHARS,
    );
  });

  it('keeps working in memory when the write is refused', () => {
    const store = new SttSettingsStore(new MemoryStorage(null, true));
    should(store.persisted).be.true();
    should(store.update({ enabled: false }).enabled).be.false();
    should(store.persisted).be.false();
  });

  it('reports a store with nowhere to write as unpersisted', () => {
    const store = new SttSettingsStore();
    store.update({ enabled: false });
    should(store.persisted).be.false();
  });

  it('notifies subscribers on a change and stops after unsubscribe', () => {
    const store = new SttSettingsStore(new MemoryStorage());
    let seen = 0;
    const unsubscribe = store.subscribe(() => {
      seen += 1;
    });

    store.update({ enabled: false });
    should(seen).equal(1);
    unsubscribe();
    store.update({ enabled: true });
    should(seen).equal(1);
  });

  it('reloads another tab’s write, publishing a new snapshot', () => {
    const storage = new MemoryStorage();
    const store = new SttSettingsStore(storage);
    let seen = 0;
    store.subscribe(() => {
      seen += 1;
    });

    storage.poke(stored({ enabled: false }));
    should(store.reload().enabled).be.false();
    should(seen).equal(1);
  });

  it('leaves the snapshot alone when a reload cannot read storage', () => {
    const store = new SttSettingsStore(new MemoryStorage(stored({ enabled: false })));
    const before = store.get();
    const blocked = new SttSettingsStore(new BlockedStorage());
    should(blocked.reload()).deepEqual(DEFAULT_STT_SETTINGS);
    should(store.get()).equal(before);
  });

  it('reloads to the defaults for a store with no storage behind it', () => {
    should(new SttSettingsStore().reload()).deepEqual(DEFAULT_STT_SETTINGS);
  });

  it('owns exactly one storage key', () => {
    should(STT_SETTINGS_KEY).equal('fy-stt-v1');
  });
});

describe('sttDictionary', () => {
  it('turns the reader’s lines into enhancer entries', () => {
    const settings = parseSttSettings(stored({ dictionary: ['kteam = kteem', '# note', 'k team'] }));
    const parsed = sttDictionary(settings);

    should(parsed.entries).deepEqual([{ term: 'kteam', aliases: ['kteem'] }]);
    should(parsed.problems).have.length(1);
  });
});
