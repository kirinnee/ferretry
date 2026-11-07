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
  snapshotQuery,
} from '../../../app/components/terminal-snapshot-model.ts';
import { refusal, scriptedClient } from '../../support/app/client.ts';

const scope = { sessionId: 'pane/session' };

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
  it('returns the daemon text, asking by route key for the ferret', async () => {
    const { calls, client } = scriptedClient('$ bun test\nok');
    expect(await readPaneSnapshot(client, scope)).toBe('$ bun test\nok');
    expect(calls).toEqual([
      {
        route: 'GET /v1/ferrets/:ferretId/snapshot',
        init: { params: { ferretId: 'pane/session' }, query: { live: 'false' } },
      },
    ]);
  });

  it('reads only the visible screen when asked', async () => {
    const { calls, client } = scriptedClient('screen');
    await readPaneSnapshot(client, scope, true, 'screen');
    expect(calls[0]?.init?.query).toEqual({ live: 'true', scope: 'screen' });
  });

  it('reads an empty pane as empty text', async () => {
    expect(await readPaneSnapshot(scriptedClient(undefined).client, scope)).toBe('');
  });

  it('keeps a capture that parses as JSON exactly as the pane drew it', async () => {
    for (const capture of ['"ok"', '[1, 2]', '  42\n', 'null']) {
      expect(await readPaneSnapshot(scriptedClient(capture).client, scope)).toBe(capture);
    }
  });

  it('asks the shell for text, never for a decoded answer', async () => {
    const { client } = scriptedClient('x');
    let decoded = 0;
    const watching = {
      ...client,
      call: async () => {
        decoded += 1;
        return undefined as never;
      },
    };
    await readPaneSnapshot(watching, scope);
    expect(decoded).toBe(0);
  });

  it('refuses a client that cannot read text rather than decode a capture as JSON', async () => {
    const plain = { call: async () => 'x' as never, subscribe: () => () => undefined };
    await expect(readPaneSnapshot(plain, scope)).rejects.toThrow('cannot read a pane snapshot as text');
  });

  it('surfaces a daemon refusal with its sentence', async () => {
    const failed = readPaneSnapshot(scriptedClient(refusal(404, 'no such pane', 'gone')).client, scope);
    await expect(failed).rejects.toMatchObject({ status: 404, code: 'gone' });
    await expect(failed).rejects.toThrow('no such pane');
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
