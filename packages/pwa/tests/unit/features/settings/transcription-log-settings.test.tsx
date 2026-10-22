import { afterEach, describe, expect, it } from 'bun:test';
import { type CleanupTrace, redactTraceHeaders } from '@ferretry/protocol';
import { callTime } from '../../../../src/features/settings/dictation-debug-settings.tsx';
import {
  TRANSCRIPTION_LOG_EMPTY,
  TRANSCRIPTION_LOG_NO_MATCH,
  TRANSCRIPTION_LOG_PAGE,
  TRANSCRIPTION_LOG_UNSAVED,
  TranscriptionLogSettings,
  textOf,
} from '../../../../src/features/settings/transcription-log-settings.tsx';
import { DictationDebugLog, type DictationDebugStorage } from '../../../../src/lib/stt/dictation-debug.ts';
import { REINSERT_TRANSCRIPTION_EVENT } from '../../../../src/lib/stt/reinsert-transcription.ts';
import {
  type NewTranscriptionEntry,
  type TranscriptionEntry,
  TranscriptionLog,
  type TranscriptionLogRecords,
  type TranscriptionLogStorage,
} from '../../../../src/lib/stt/transcription-log.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

const fakeStorage = (): TranscriptionLogStorage & DictationDebugStorage => {
  const kept = new Map<string, string>();
  return { getItem: key => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value) };
};

const fakeRecords = (): TranscriptionLogRecords => {
  const rows = new Map<string, TranscriptionEntry>();
  return {
    list: async () => [...rows.values()],
    put: async entry => void rows.set(entry.id, entry),
    delete: async id => void rows.delete(id),
    clear: async () => rows.clear(),
  };
};

const buildLog = (records: TranscriptionLogRecords | null = fakeRecords()): TranscriptionLog => {
  let issued = 0;
  return new TranscriptionLog(records ?? undefined, {
    storage: fakeStorage(),
    now: () => NOW,
    newId: () => {
      issued += 1;
      return `entry-${String(issued)}`;
    },
  });
};

const dictation = (overrides: Partial<NewTranscriptionEntry> = {}): NewTranscriptionEntry => ({
  at: NOW,
  engine: 'parakeet',
  raw: 'um hello there',
  outcome: 'inserted',
  ...overrides,
});

const traceOf = (): CleanupTrace => ({
  via: 'device',
  provider: 'groq',
  model: 'llama-3.3-70b',
  host: 'api.groq.com',
  totalMs: 420,
  outcome: 'cleaned',
  attempts: [
    {
      withContext: false,
      request: {
        host: 'api.groq.com',
        path: '/p',
        headers: redactTraceHeaders({ authorization: 'Bearer never-shown' }),
        params: {},
        messages: [{ role: 'user', content: 'um hello there' }],
      },
      timings: { totalMs: 420 },
    },
  ],
});

const mounted: Mounted[] = [];
const show = async (element: Parameters<typeof mount>[0]): Promise<HTMLElement> => {
  const view = await mount(element);
  mounted.push(view);
  return view.container;
};

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount();
});

const buttonWith = (root: ParentNode, text: string, index = 0): HTMLButtonElement =>
  must(
    [...root.querySelectorAll<HTMLButtonElement>('button')].filter(button => (button.textContent ?? '').includes(text))[
      index
    ],
    `the "${text}" button`,
  );
const theSwitch = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector('button[role="switch"]'), 'the switch');
const click = async (element: HTMLElement): Promise<void> => {
  await interact(() => element.click());
};
const entries = (root: ParentNode): string[] =>
  [...root.querySelectorAll('[data-log-entry]')].map(entry => entry.textContent ?? '');

const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const typeInto = async (element: HTMLInputElement, text: string): Promise<void> => {
  await interact(() => {
    inputValueSetter?.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const copier = () => {
  const copied: string[] = [];
  return { copied, copy: async (text: string) => void copied.push(text) };
};
const refusing = async (): Promise<void> => {
  throw new Error('refused');
};

describe('textOf', () => {
  const entry: TranscriptionEntry = { id: 'a', at: 1, engine: 'parakeet', raw: 'raw', outcome: 'pending' };

  it('should prefer the words the owner edited in, then the cleaned text, then the raw', () => {
    expect(textOf({ ...entry, inserted: 'edited', cleaned: 'clean' })).toBe('edited');
    expect(textOf({ ...entry, cleaned: 'clean' })).toBe('clean');
    expect(textOf(entry)).toBe('raw');
  });
});

describe('TranscriptionLogSettings timings', () => {
  const timed = (speechMs: number, cleanupMs: number): NewTranscriptionEntry['timeline'] => ({
    totalMs: speechMs + cleanupMs + 50,
    speech: { engine: 'parakeet', totalMs: speechMs },
    cleanup: { provider: 'groq', via: 'device', outcome: 'cleaned', attempts: 1, totalMs: cleanupMs },
  });

  it('should put a median and p90 summary above the list, and a bar on each timed dictation', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ raw: 'first', timeline: timed(100, 900) }));
    log.add(dictation({ raw: 'second', timeline: timed(200, 1_000) }));
    log.add(dictation({ raw: 'untimed' }));

    // Act
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Assert
    expect(view.querySelector('[data-timing-summary]')?.textContent).toContain('Last 2 timed dictations');
    expect(view.querySelectorAll('[data-log-entry] [data-timeline-bar]')).toHaveLength(2);
    expect(view.querySelector('[data-log-entry] [data-timeline-line]')?.textContent).toContain('slowest: cleanup');
  });

  it('should show no summary and no bar when nothing was timed', async () => {
    const log = buildLog();
    log.add(dictation());
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);
    expect(view.querySelector('[data-timing-summary]')).toBeNull();
    expect(view.querySelector('[data-timeline-bar]')).toBeNull();
  });
});

describe('TranscriptionLogSettings', () => {
  it('should be on by default and say what an empty log means', async () => {
    // Arrange
    const log = buildLog();

    // Act
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Assert
    expect(theSwitch(view).getAttribute('aria-checked')).toBe('true');
    expect(view.textContent).toContain(TRANSCRIPTION_LOG_EMPTY);
    expect(view.textContent).not.toContain(TRANSCRIPTION_LOG_UNSAVED);
    expect(buttonWith(view, 'Clear log').disabled).toBe(true);
    expect(view.textContent).toContain('No audio is stored');
  });

  it('should list what each dictation was, with and without the optional facts', async () => {
    // Arrange
    const log = buildLog();
    log.add(
      dictation({
        sessionLabel: 'Fix the build',
        durationMs: 2_300,
        cleaned: 'Hello there.',
        prompt: 'polish',
        outcome: 'discarded',
      }),
    );
    log.add(dictation({ at: NOW - 1, engine: 'web-speech', raw: 'plain words', outcome: 'pending' }));
    log.add(dictation({ at: NOW - 2, raw: 'edited words', inserted: 'My edit', prompt: 'fix' }));

    // Act
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Assert
    const [first, second, third] = entries(view);
    expect(first).toContain(callTime(NOW));
    expect(first).toContain('Fix the build · Parakeet in-browser · 2.3 s · Polish prompt · Discarded');
    expect(first).toContain('Heard: um hello there');
    expect(first).toContain('Cleaned: Hello there.');
    expect(second).toContain('Web Speech · Not decided');
    expect(second).not.toContain('Cleaned:');
    expect(third).toContain('Fix prompt · Inserted');
    expect(third).toContain('You inserted: My edit');
  });

  it('should search, say when nothing matches, and show every entry again when the search clears', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ raw: 'send the invoice' }));
    log.add(dictation({ at: NOW - 1, raw: 'water the plants' }));
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);
    const search = must(view.querySelector('input[type="search"]') as HTMLInputElement | null, 'the search box');

    // Act
    await typeInto(search, 'invoice');
    const narrowed = entries(view);
    await typeInto(search, 'zebra');
    const none = view.textContent;
    await typeInto(search, '');

    // Assert
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]).toContain('send the invoice');
    expect(none).toContain(TRANSCRIPTION_LOG_NO_MATCH);
    expect(entries(view)).toHaveLength(2);
  });

  it('should show a page at a time and reveal more on request', async () => {
    // Arrange
    const log = buildLog();
    for (let index = 0; index < TRANSCRIPTION_LOG_PAGE + 5; index += 1) {
      log.add(dictation({ at: NOW - index, raw: `dictation ${String(index)}` }));
    }
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Act
    const firstPage = entries(view).length;
    await click(buttonWith(view, 'Show more'));

    // Assert
    expect(firstPage).toBe(TRANSCRIPTION_LOG_PAGE);
    expect(entries(view)).toHaveLength(TRANSCRIPTION_LOG_PAGE + 5);
    expect(view.textContent).not.toContain('Show more');
  });

  it('should return to the first page when the search changes', async () => {
    // Arrange
    const log = buildLog();
    for (let index = 0; index < TRANSCRIPTION_LOG_PAGE * 2 + 1; index += 1) {
      log.add(dictation({ at: NOW - index, raw: `note ${String(index)}` }));
    }
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);
    await click(buttonWith(view, 'Show more'));
    const search = must(view.querySelector('input[type="search"]') as HTMLInputElement | null, 'the search box');

    // Act
    await typeInto(search, 'note');

    // Assert
    expect(entries(view)).toHaveLength(TRANSCRIPTION_LOG_PAGE);
  });

  it('should clear the log and switch recording off without dropping what is kept', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation());
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Act
    await click(theSwitch(view));
    const afterSwitch = [theSwitch(view).getAttribute('aria-checked'), entries(view).length];
    await click(buttonWith(view, 'Clear log'));

    // Assert
    expect(afterSwitch).toEqual(['false', 1]);
    expect(entries(view)).toHaveLength(0);
    expect(view.textContent).toContain(TRANSCRIPTION_LOG_EMPTY);
  });

  it('should say so when this browser would not save the log', async () => {
    // Arrange
    const log = buildLog(null);
    log.add(dictation());

    // Act
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Assert
    expect(view.textContent).toContain(TRANSCRIPTION_LOG_UNSAVED);
    expect(entries(view)).toHaveLength(1);
  });

  it('should render, and ignore every control, when there is no log at all', async () => {
    // Act
    const injected = await show(<TranscriptionLogSettings log={null} debug={null} />);
    await click(theSwitch(injected));
    const ambient = await show(<TranscriptionLogSettings />);

    // Assert
    expect(injected.textContent).toContain(TRANSCRIPTION_LOG_UNSAVED);
    expect(ambient.textContent).toContain(TRANSCRIPTION_LOG_EMPTY);
  });
});

describe('copying from the log', () => {
  it('should copy what was kept, or the raw words when those differ, and confirm it', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ cleaned: 'Hello there.' }));
    const { copied, copy } = copier();
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copy} />);

    // Act
    await click(buttonWith(view, 'Copy'));
    const note = view.querySelector('[data-log-note]')?.textContent;
    await click(buttonWith(view, 'Copy raw'));

    // Assert
    expect(copied).toEqual(['Hello there.', 'um hello there']);
    expect(note).toBe('Copied.');
  });

  it('should offer one copy button when the kept words are the raw words', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation());
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copier().copy} />);

    // Assert
    expect(view.textContent).not.toContain('Copy raw');
  });

  it('should say so when the browser refuses the copy', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation());
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={refusing} />);

    // Act
    await click(buttonWith(view, 'Copy'));

    // Assert
    expect(view.querySelector('[data-log-note]')?.getAttribute('data-log-note')).toBe('copy-failed');
    expect(view.textContent).toContain('would not let the words be copied');
  });

  it('should write to the browser clipboard by default', async () => {
    // Arrange
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    const log = buildLog();
    log.add(dictation());
    const view = await show(<TranscriptionLogSettings log={log} debug={null} />);

    // Act
    try {
      await click(buttonWith(view, 'Copy'));
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis.navigator, 'clipboard');
      else Object.defineProperty(globalThis.navigator, 'clipboard', original);
    }

    // Assert
    expect(written).toEqual(['um hello there']);
  });
});

describe('putting an entry back', () => {
  it('should hand the words to a composer that takes them, with nothing else said', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ sessionId: 's1', cleaned: 'Hello there.', inserted: 'Hello, you.' }));
    const asked: TranscriptionEntry[] = [];
    const { copied, copy } = copier();
    const view = await show(
      <TranscriptionLogSettings
        log={log}
        debug={null}
        copy={copy}
        onReinsert={entry => {
          asked.push(entry);
          return true;
        }}
      />,
    );

    // Act
    await click(buttonWith(view, 'Insert again'));

    // Assert
    expect(asked.map(entry => entry.id)).toEqual(['entry-1']);
    expect(copied).toEqual([]);
    expect(view.querySelector('[data-log-note]')).toBeNull();
  });

  it('should copy the words instead, and say so, when no composer takes them', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ cleaned: 'Hello there.' }));
    const { copied, copy } = copier();
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copy} onReinsert={() => false} />);

    // Act
    await click(buttonWith(view, 'Insert again'));

    // Assert
    expect(copied).toEqual(['Hello there.']);
    expect(view.querySelector('[data-log-note]')?.textContent).toBe('No conversation is open — copied instead.');
  });

  it('should say so when nothing takes the words and the copy is refused too', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation());
    const view = await show(
      <TranscriptionLogSettings log={log} debug={null} copy={refusing} onReinsert={() => false} />,
    );

    // Act
    await click(buttonWith(view, 'Insert again'));

    // Assert
    expect(view.querySelector('[data-log-note]')?.getAttribute('data-log-note')).toBe('copy-failed');
  });

  it('should announce the request on the window by default and be taken by a composer', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ sessionId: 's1', cleaned: 'Hello there.' }));
    const heard: unknown[] = [];
    const listener = (event: Event) => {
      event.preventDefault();
      heard.push((event as CustomEvent).detail);
    };
    globalThis.addEventListener(REINSERT_TRANSCRIPTION_EVENT, listener);
    const { copied, copy } = copier();
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copy} />);

    // Act
    try {
      await click(buttonWith(view, 'Insert again'));
    } finally {
      globalThis.removeEventListener(REINSERT_TRANSCRIPTION_EVENT, listener);
    }

    // Assert
    expect(heard).toEqual([{ sessionId: 's1', text: 'Hello there.' }]);
    expect(copied).toEqual([]);
  });

  it('should fall back to copying when nothing on the window answers the default request', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation());
    const { copied, copy } = copier();
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copy} />);

    // Act
    await click(buttonWith(view, 'Insert again'));

    // Assert
    expect(copied).toEqual(['um hello there']);
    expect(view.querySelector('[data-log-note]')?.getAttribute('data-log-note')).toBe('copied-instead');
  });

  it('should keep a note on the row it belongs to only', async () => {
    // Arrange
    const log = buildLog();
    log.add(dictation({ raw: 'first' }));
    log.add(dictation({ at: NOW - 1, raw: 'second' }));
    const view = await show(<TranscriptionLogSettings log={log} debug={null} copy={copier().copy} />);

    // Act
    await click(buttonWith(view, 'Copy', 1));

    // Assert
    const [first, second] = [...view.querySelectorAll('[data-log-entry]')];
    expect(first?.querySelector('[data-log-note]')).toBeNull();
    expect(second?.querySelector('[data-log-note]')?.textContent).toBe('Copied.');
  });
});

describe('the link to a debug record', () => {
  it('should offer details only for an entry whose record is still in the ring, and open it', async () => {
    // Arrange
    const debug = new DictationDebugLog(fakeStorage());
    debug.setEnabled(true);
    const debugId = debug.record(traceOf(), NOW);
    const log = buildLog();
    log.add(dictation({ raw: 'linked', debugId }));
    log.add(dictation({ at: NOW - 1, raw: 'gone', debugId: 'debug-99' }));
    log.add(dictation({ at: NOW - 2, raw: 'never had one' }));
    const view = await show(<TranscriptionLogSettings log={log} debug={debug} />);

    // Act
    const offered = [...view.querySelectorAll('[data-log-entry]')].map(entry =>
      (entry.textContent ?? '').includes('Debug details'),
    );
    await click(buttonWith(view, 'Debug details'));
    const opened = document.body.textContent;
    await click(must(document.querySelector('button[aria-label="Close"]'), 'the sheet close') as HTMLElement);

    // Assert
    expect(offered).toEqual([true, false, false]);
    expect(opened).toContain('Dictation details');
    expect(document.body.textContent).not.toContain('Dictation details');
  });

  it('should close the sheet when the debug record leaves the ring', async () => {
    // Arrange
    const debug = new DictationDebugLog(fakeStorage());
    debug.setEnabled(true);
    const debugId = debug.record(traceOf(), NOW);
    const log = buildLog();
    log.add(dictation({ debugId }));
    const view = await show(<TranscriptionLogSettings log={log} debug={debug} />);
    await click(buttonWith(view, 'Debug details'));

    // Act
    await interact(() => debug.setEnabled(false));

    // Assert
    expect(document.body.textContent).not.toContain('Dictation details');
    expect(view.textContent).not.toContain('Debug details');
  });
});
