import { describe, expect, test } from 'bun:test';
import type { LogPageOptions, SessionLogPage } from '@ferretry/protocol';
import {
  type SessionWorkspaceRefreshEnvironment,
  startSessionWorkspaceRefresh,
} from '../../src/components/session-workspace-model.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';
import {
  EMPTY_HISTORY,
  historyLog,
  historyMeetsTail,
  type LogPage,
  oldestStart,
  type TranscriptHistoryStatus,
  withGap,
  withOlder,
  withTail,
} from '../../src/lib/transcript-history.ts';
import { sessionView } from '../support/sessions.ts';

/**
 * Scrolling a chat all the way back to its first message.
 *
 * The chat used to hold only a session's newest events, re-read on every poll, so a reader scrolling up
 * met a wall. These cases run the chat's refresh against a daemon that pages like the real one — whole
 * records, `start` offsets, a tail that moves forward as the agent writes — and prove what the reader
 * sees is every message exactly once, in order, however the pages and the polls interleave.
 */

const page = (log: string, start: number, file = 'f1'): LogPage => ({ log, start, file });

describe('the history model', () => {
  test('a tail with nothing older held is simply the history', () => {
    const outcome = withTail(EMPTY_HISTORY, page('b', 20));
    expect(outcome).toEqual({ kind: 'applied', history: { ...EMPTY_HISTORY, tail: page('b', 20) } });
  });

  test('an older page goes in front, and the history then ends where that tail began', () => {
    const history = withOlder({ ...EMPTY_HISTORY, tail: page('b', 20) }, page('a', 0), 20);
    expect(historyLog(history)).toBe('a\nb');
    expect(oldestStart(history)).toBe(0);
    expect(history.anchor).toBe(20);
  });

  test('a tail that moved past the held history asks for the gap, and the gap joins them', () => {
    const held = withOlder({ ...EMPTY_HISTORY, tail: page('b', 20) }, page('a', 0), 20);
    expect(withTail(held, page('c', 30))).toEqual({ kind: 'gap', from: 20, before: 30, file: 'f1' });
    const joined = withGap(held, page('b', 20), page('c', 30));
    expect(historyLog(joined)).toBe('a\nb\nc');
    expect(joined.anchor).toBe(30);
  });

  test('a gap that could not be read whole starts the history again at the tail', () => {
    const held = withOlder({ ...EMPTY_HISTORY, tail: page('b', 20) }, page('a', 0), 20);
    expect(withGap(held, page('b', 25), page('c', 30))).toEqual({ ...EMPTY_HISTORY, tail: page('c', 30) });
  });

  test('a tail of another file, or one that begins before the history ends, starts again', () => {
    const held = withOlder({ ...EMPTY_HISTORY, tail: page('b', 20) }, page('a', 0), 20);
    expect(withTail(held, page('x', 20, 'f2'))).toEqual({
      kind: 'applied',
      history: { ...EMPTY_HISTORY, tail: page('x', 20, 'f2') },
    });
    expect(withTail(held, page('x', 10))).toEqual({
      kind: 'applied',
      history: { ...EMPTY_HISTORY, tail: page('x', 10) },
    });
  });

  test('an older page of another file, or for a place the history no longer begins at, is not joined', () => {
    const tailOnly = { ...EMPTY_HISTORY, tail: page('b', 20) };
    expect(withOlder(tailOnly, page('a', 0, 'f2'), 20)).toBe(tailOnly);
    expect(withOlder(tailOnly, page('a', 0), 30)).toBe(tailOnly);
    const held = withOlder(tailOnly, page('a', 10), 20);
    expect(withOlder(held, page('z', 0), 20)).toBe(held);
  });

  test('an older page asked for before the tail moved still joins, and leaves a gap to fill', () => {
    const moved = { ...EMPTY_HISTORY, tail: page('c', 30) };
    const history = withOlder(moved, page('a', 0), 20);
    expect(history.anchor).toBe(20);
    expect(historyMeetsTail(history)).toBe(false);
  });
});

/**
 * A daemon over a transcript of one-line records, each `STRIDE` bytes, paging exactly as the real one
 * does: whole records, the newest `limit` of a range, and a `start` at the range's floor when nothing
 * was dropped.
 */
const STRIDE = 100;

class PagingDaemon {
  count: number;
  file = 'f1';
  readonly calls: LogPageOptions[] = [];
  /** Answers the next older (`before` without `from`) read with this, once. */
  holdOlder: Promise<void> | undefined;
  failOlder: unknown;

  constructor(count: number) {
    this.count = count;
  }

  line(index: number): string {
    const clock = new Date(Date.UTC(2026, 9, 18, 0, 0, 0) + index * 1000).toISOString().slice(11, 19);
    return `[${clock}] user/message: m${String(index)}`;
  }

  async logPage(_id: string, options: LogPageOptions = {}): Promise<SessionLogPage> {
    this.calls.push(options);
    if (options.before !== undefined && options.from === undefined) {
      const hold = this.holdOlder;
      this.holdOlder = undefined;
      if (hold !== undefined) await hold;
      if (this.failOlder !== undefined) {
        const failure = this.failOlder;
        this.failOlder = undefined;
        throw failure;
      }
    }
    if (options.file !== undefined && options.file !== this.file)
      throw Object.assign(new Error('stale'), { status: 409, code: 'log_cursor_stale' });
    const limit = options.limit ?? 200;
    const size = this.count * STRIDE;
    const before = Math.min(options.before ?? size, size);
    const from = options.from ?? 0;
    const first = Math.ceil(from / STRIDE);
    const end = Math.ceil(before / STRIDE);
    const kept = Math.max(first, end - limit);
    const trimmed = kept > first;
    const indexes = Array.from({ length: end - kept }, (_, offset) => kept + offset);
    return {
      v: 1,
      sessionId: 's-1',
      log: indexes.map(index => this.line(index)).join('\n'),
      // The tail begins at its first record; a page that dropped nothing begins at its floor.
      start: options.before === undefined || trimmed ? kept * STRIDE : from,
      file: this.file,
    };
  }
}

const environment: SessionWorkspaceRefreshEnvironment = {
  visible: () => true,
  setInterval: () => 'timer',
  clearInterval: () => undefined,
  onVisibility: () => () => undefined,
};

const chat = (daemon: PagingDaemon, logPage = true) => {
  let entries: readonly TranscriptEntry[] = [];
  const statuses: TranscriptHistoryStatus[] = [];
  const control = startSessionWorkspaceRefresh({
    api: {
      logs: async () => daemon.line(daemon.count - 1),
      get: async () => sessionView('s-1'),
      ...(logPage
        ? { logPage: async (id: string, options?: LogPageOptions) => await daemon.logPage(id, options) }
        : {}),
    },
    sessionId: 's-1',
    environment,
    onTranscript: next => {
      entries = next;
    },
    onHistory: status => statuses.push(status),
    onSession: () => undefined,
    onError: () => undefined,
  });
  return {
    control,
    texts: () => entries.map(entry => entry.text),
    status: () => statuses.at(-1),
  };
};

const messages = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, offset) => `m${String(from + offset)}`);

describe('scrolling a chat back to its first message', () => {
  test('loads page after page until the first message, with every message once and in order', async () => {
    const daemon = new PagingDaemon(1_050);
    const view = chat(daemon);
    await view.control.initial;
    expect(view.texts()).toEqual(messages(850, 1_050));
    expect(view.status()).toBe('more');

    let loads = 0;
    while (view.status() === 'more' && loads < 20) {
      await view.control.loadOlder();
      loads += 1;
    }
    view.control.stop();

    expect(view.status()).toBe('start');
    expect(loads).toBe(5);
    expect(view.texts()).toEqual(messages(0, 1_050));
  });

  test('keeps the older history joined while the agent writes, reading only the gap the tail left', async () => {
    const daemon = new PagingDaemon(600);
    const view = chat(daemon);
    await view.control.initial;
    await view.control.loadOlder();
    expect(view.texts()).toEqual(messages(200, 600));

    daemon.count = 650;
    daemon.calls.length = 0;
    await view.control.refresh();
    view.control.stop();

    expect(view.texts()).toEqual(messages(200, 650));
    // The tail, then the 50 records between where the history ended and where the new tail begins.
    expect(daemon.calls).toEqual([{}, { before: 450 * STRIDE, from: 400 * STRIDE, limit: 2_000, file: 'f1' }]);
  });

  test('joins an older page that was in flight while the tail moved, without a hole between them', async () => {
    const daemon = new PagingDaemon(600);
    const view = chat(daemon);
    await view.control.initial;
    let release: () => void = () => undefined;
    daemon.holdOlder = new Promise<void>(resolve => {
      release = resolve;
    });
    const loading = view.control.loadOlder();
    expect(view.status()).toBe('loading');

    daemon.count = 640;
    await view.control.refresh();
    release();
    await loading;
    await view.control.refresh();
    view.control.stop();

    expect(view.texts()).toEqual(messages(200, 640));
  });

  test('starts again at the tail when the agent wrote more than a gap can hold', async () => {
    const daemon = new PagingDaemon(600);
    const view = chat(daemon);
    await view.control.initial;
    await view.control.loadOlder();

    daemon.count = 600 + 9_000;
    await view.control.refresh();
    view.control.stop();

    expect(view.texts()).toEqual(messages(9_400, 9_600));
    expect(view.status()).toBe('more');
  });

  test('drops the older history when the session’s transcript became another file', async () => {
    const daemon = new PagingDaemon(600);
    const view = chat(daemon);
    await view.control.initial;
    await view.control.loadOlder();

    daemon.file = 'f2';
    await view.control.refresh();
    expect(view.texts()).toEqual(messages(400, 600));
    view.control.stop();
  });

  test('starts again when an older page is refused because the file changed under it', async () => {
    const daemon = new PagingDaemon(600);
    const view = chat(daemon);
    await view.control.initial;

    daemon.file = 'f2';
    await view.control.loadOlder();
    await view.control.refresh();
    view.control.stop();

    expect(view.texts()).toEqual(messages(400, 600));
    expect(view.status()).toBe('more');
  });

  test('says a failed older page, and loads it when asked again', async () => {
    const daemon = new PagingDaemon(300);
    const view = chat(daemon);
    await view.control.initial;

    daemon.failOlder = new Error('offline');
    await view.control.loadOlder();
    expect(view.status()).toBe('error');

    await view.control.loadOlder();
    view.control.stop();
    expect(view.status()).toBe('start');
    expect(view.texts()).toEqual(messages(0, 300));
  });

  test('a short conversation is already whole: nothing older is offered', async () => {
    const view = chat(new PagingDaemon(30));
    await view.control.initial;
    view.control.stop();
    expect(view.status()).toBe('start');
    expect(view.texts()).toEqual(messages(0, 30));
  });

  test('reads an older daemon with no page route through logs, offering no older history', async () => {
    const daemon = new PagingDaemon(300);
    const view = chat(daemon, false);
    await view.control.initial;
    await view.control.loadOlder();
    view.control.stop();
    expect(view.texts()).toEqual(['m299']);
    expect(view.status()).toBe('unavailable');
  });

  test('falls back to logs for good once the daemon says the page route is unknown', async () => {
    const calls: string[] = [];
    const control = startSessionWorkspaceRefresh({
      api: {
        logs: async () => {
          calls.push('logs');
          return '[00:00:00] user/message: hello';
        },
        logPage: async () => {
          calls.push('logPage');
          throw Object.assign(new Error('no route'), { status: 404, code: 'unknown_route' });
        },
        get: async () => sessionView('s-1'),
      },
      sessionId: 's-1',
      environment,
      onTranscript: () => undefined,
      onSession: () => undefined,
      onError: () => undefined,
    });
    await control.initial;
    await control.refresh();
    control.stop();
    expect(calls).toEqual(['logPage', 'logs', 'logs']);
  });
});
