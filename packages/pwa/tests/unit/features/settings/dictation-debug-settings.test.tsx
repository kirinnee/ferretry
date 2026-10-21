import { afterEach, describe, expect, it } from 'bun:test';
import { type CleanupTrace, redactTraceHeaders } from '@ferretry/protocol';
import {
  callDuration,
  callTime,
  DICTATION_DEBUG_EMPTY,
  DICTATION_DEBUG_OFF_HINT,
  DictationDebugSettings,
} from '../../../../src/features/settings/dictation-debug-settings.tsx';
import { DictationDebugLog, type DictationDebugStorage } from '../../../../src/lib/stt/dictation-debug.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

const fakeStorage = (): DictationDebugStorage => {
  const kept = new Map<string, string>();
  return { getItem: key => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value) };
};

const traceOf = (overrides: Partial<CleanupTrace> = {}): CleanupTrace => ({
  via: 'device',
  provider: 'groq',
  model: 'llama-3.3-70b',
  host: 'api.groq.com',
  totalMs: 420,
  outcome: 'cleaned',
  finalText: 'Hello there.',
  attempts: [
    {
      withContext: false,
      request: {
        host: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        headers: redactTraceHeaders({ authorization: 'Bearer never-shown' }),
        params: {},
        messages: [{ role: 'user', content: 'hello there' }],
      },
      timings: { totalMs: 420 },
    },
  ],
  ...overrides,
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

const buttons = (root: ParentNode): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('button')];
const buttonWith = (root: ParentNode, text: string): HTMLButtonElement =>
  must(
    buttons(root).find(button => (button.textContent ?? '').includes(text)),
    `the "${text}" button`,
  );
const theSwitch = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector('button[role="switch"]'), 'the switch');
const click = async (element: HTMLElement): Promise<void> => {
  await interact(() => element.click());
};

describe('DictationDebugSettings', () => {
  it('should start off, say nothing is kept and offer no clear', async () => {
    // Arrange
    const log = new DictationDebugLog(fakeStorage());

    // Act
    const view = await show(<DictationDebugSettings log={log} />);

    // Assert
    expect(theSwitch(view).getAttribute('aria-checked')).toBe('false');
    expect(view.textContent).toContain(DICTATION_DEBUG_OFF_HINT);
    expect(buttonWith(view, 'Clear calls').disabled).toBe(true);
    expect(view.textContent).toContain('last 10 calls in memory only');
  });

  it('should switch on, wait for a call, list it and drop it again on switch-off', async () => {
    // Arrange
    const log = new DictationDebugLog(fakeStorage());
    const view = await show(<DictationDebugSettings log={log} />);

    // Act
    await click(theSwitch(view));
    const waiting = view.textContent;
    await interact(() => void log.record(traceOf(), NOW));
    const listed = view.textContent;
    await click(theSwitch(view));

    // Assert
    expect(waiting).toContain(DICTATION_DEBUG_EMPTY);
    expect(listed).toContain('groq · llama-3.3-70b');
    expect(listed).toContain('Cleaned');
    expect(listed).toContain('420 ms');
    expect(listed).toContain('this browser → api.groq.com');
    expect(log.snapshot().records).toHaveLength(0);
    expect(view.textContent).toContain(DICTATION_DEBUG_OFF_HINT);
  });

  it('should name each outcome, the path and a slow call, newest first', async () => {
    // Arrange
    const log = new DictationDebugLog(fakeStorage());
    log.setEnabled(true);
    log.record(traceOf({ outcome: 'kept_raw' }), NOW);
    log.record(traceOf({ outcome: 'failed', via: 'daemon', host: 'daemon.local', totalMs: 1_500 }), NOW + 1);

    // Act
    const view = await show(<DictationDebugSettings log={log} />);

    // Assert
    const rows = [...view.querySelectorAll('[data-debug-call]')].map(row => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Failed');
    expect(rows[0]).toContain('1.5 s');
    expect(rows[0]).toContain('a machine → daemon.local');
    expect(rows[1]).toContain('Kept your words');
  });

  it('should open a call in the details sheet, close it, and close it when the call is cleared', async () => {
    // Arrange
    const log = new DictationDebugLog(fakeStorage());
    log.setEnabled(true);
    log.record(traceOf(), NOW);
    const view = await show(<DictationDebugSettings log={log} />);

    // Act
    await click(must(view.querySelector('[data-debug-call]'), 'the call row') as HTMLElement);
    const opened = document.body.textContent;
    await click(must(document.querySelector('button[aria-label="Close"]'), 'the sheet close') as HTMLElement);
    const closed = document.body.textContent;
    await click(must(view.querySelector('[data-debug-call]'), 'the call row') as HTMLElement);
    await click(buttonWith(view, 'Clear calls'));

    // Assert
    expect(opened).toContain('Dictation details');
    expect(closed).not.toContain('Dictation details');
    expect(document.body.textContent).not.toContain('Dictation details');
    expect(log.snapshot().records).toHaveLength(0);
  });

  it('should render and ignore clicks when there is no log at all', async () => {
    // Act
    const injected = await show(<DictationDebugSettings log={null} />);
    await click(theSwitch(injected));
    const ambient = await show(<DictationDebugSettings />);

    // Assert
    expect(theSwitch(injected).getAttribute('aria-checked')).toBe('false');
    expect(theSwitch(ambient).getAttribute('aria-checked')).toBe('false');
    expect(ambient.textContent).toContain(DICTATION_DEBUG_OFF_HINT);
  });
});

describe('call formatting', () => {
  it('should print milliseconds under a second and seconds from a second up', () => {
    expect(callDuration(0)).toBe('0 ms');
    expect(callDuration(419.6)).toBe('420 ms');
    expect(callDuration(1_000)).toBe('1.0 s');
    expect(callDuration(2_340)).toBe('2.3 s');
  });

  it('should print a time on the reader’s clock and say so when it cannot', () => {
    expect(callTime(NOW)).toMatch(/2026/u);
    expect(callTime(8.64e15 + 1)).toBe('Unknown time');
  });
});
