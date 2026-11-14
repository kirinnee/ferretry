import { describe, expect, it } from 'bun:test';
import {
  describeSnapshotError,
  FIT_MAX_FONT_PX,
  FIT_MIN_FONT_PX,
  fitFontPx,
  formatSnapshotAge,
  formatSnapshotClock,
  paneColumns,
  readPaneSnapshot,
  SNAPSHOT_ROUTE,
  snapshotQuery,
} from '../../../app/components/terminal-snapshot-model.ts';
import { daemonConnection, daemonSessionScope } from '../../../app/shell.ts';
import { DaemonCallError } from '@ferretry/app';

const daemon = daemonConnection('pane-daemon');
const scope = daemonSessionScope(daemon, 'pane/session');

const other = daemonConnection('other-daemon');

/** A client that records every call by route key and answers with the scripted text. */
const reading = (answer: unknown) => {
  const calls: { route: string; init: unknown }[] = [];
  const client = {
    call: async <T>(route: string, init?: unknown): Promise<T> => {
      calls.push({ route, init });
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { calls, client };
};

describe('terminal snapshot query', () => {
  it('asks for the cached snapshot by default', () => {
    expect(snapshotQuery()).toEqual({ live: 'false' });
    expect(snapshotQuery(true)).toEqual({ live: 'true' });
  });

  it('adds the screen scope only when asked, so the default query never changes', () => {
    expect(snapshotQuery(true, 'history')).toEqual({ live: 'true' });
    expect(snapshotQuery(true, 'screen')).toEqual({ live: 'true', scope: 'screen' });
  });
});

describe('reading a pane snapshot', () => {
  it('returns the daemon text for a scope that belongs to the daemon', async () => {
    const { calls, client } = reading('$ bun test\nok');
    const text = await readPaneSnapshot(client, daemon, scope);
    expect(text).toBe('$ bun test\nok');
    expect(calls).toEqual([
      { route: SNAPSHOT_ROUTE, init: { params: { ferretId: 'pane/session' }, query: { live: 'false' }, quiet: true } },
    ]);
  });

  it('reads only the visible screen when asked', async () => {
    const { calls, client } = reading('screen');
    await readPaneSnapshot(client, daemon, scope, undefined, true, 'screen');
    expect(calls[0]?.init).toEqual({
      params: { ferretId: 'pane/session' },
      query: { live: 'true', scope: 'screen' },
      quiet: true,
    });
  });

  it('refuses a scope belonging to another daemon rather than crossing the pair', async () => {
    const { calls, client } = reading('');
    await expect(readPaneSnapshot(client, other, scope)).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
    expect(calls).toEqual([]);
  });

  it('surfaces the daemon’s refusal as the shell client raised it', async () => {
    const { client } = reading(new DaemonCallError(404, 'gone', 'no such pane'));
    const failed = readPaneSnapshot(client, daemon, scope);
    await expect(failed).rejects.toBeInstanceOf(DaemonCallError);
    await expect(failed).rejects.toThrow('no such pane');
  });

  it('answers as the cancel when the read was cancelled while in flight', async () => {
    const { client } = reading('late text');
    const cancel = new AbortController();
    const read = readPaneSnapshot(client, daemon, scope, cancel.signal);
    cancel.abort();
    await expect(read).rejects.toThrow();
  });
});

describe('snapshot freshness strings', () => {
  it('describes an error whether or not it is an Error', () => {
    expect(describeSnapshotError(new Error('offline'))).toBe('offline');
    expect(describeSnapshotError('offline')).toBe('offline');
  });

  it('keeps the seconds visible instead of collapsing to bare minutes', () => {
    expect(formatSnapshotAge(-10)).toBe('<1s');
    expect(formatSnapshotAge(400)).toBe('<1s');
    expect(formatSnapshotAge(12_000)).toBe('12s');
    expect(formatSnapshotAge(184_000)).toBe('3m 4s');
  });

  it('prints a zero-padded wall clock and nothing at all for a bad instant', () => {
    const at = new Date(2026, 6, 31, 9, 5, 3).getTime();
    expect(formatSnapshotClock(at)).toBe('09:05:03');
    expect(formatSnapshotClock(Number.NaN)).toBe('');
  });
});

describe('fit to width', () => {
  it('counts the columns the text really uses: the widest line, trailing blanks and wide glyphs as one each', () => {
    expect(paneColumns('')).toBe(0);
    expect(paneColumns('ab\nabcd   \nabc')).toBe(4);
    expect(paneColumns('╭──╮\n│ ✻ │')).toBe(5);
  });

  it('sizes the text so the widest line fits, never above 12px nor below the readable floor', () => {
    // An 80-column pane in a 390px phone's ~342px of text: a little over 7px.
    expect(fitFontPx(80, 342)).toBe(7);
    expect(fitFontPx(20, 342)).toBe(FIT_MAX_FONT_PX);
    expect(fitFontPx(400, 342)).toBe(FIT_MIN_FONT_PX);
    expect(fitFontPx(0, 342)).toBe(FIT_MAX_FONT_PX);
    expect(fitFontPx(80, 0)).toBe(FIT_MAX_FONT_PX);
  });
});
