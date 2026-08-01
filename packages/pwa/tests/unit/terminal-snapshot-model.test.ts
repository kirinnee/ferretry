import { describe, expect, it } from 'bun:test';
import {
  describeSnapshotError,
  formatSnapshotAge,
  formatSnapshotClock,
  isPinnedToBottom,
  readPaneSnapshot,
  snapshotUrl,
} from '../../src/components/terminal-snapshot-model.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemon = daemonConnection({
  daemonId: 'pane-daemon',
  baseUrl: 'https://pane.example.test',
  deviceToken: 'pane-token',
});
const scope = daemonSessionScope(daemon, 'pane/session');

const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceToken: 'other-token',
});

describe('terminal snapshot url', () => {
  it('asks for the cached snapshot by default and escapes the session id', () => {
    expect(snapshotUrl(scope)).toBe('/v1/sessions/pane%2Fsession/snapshot?live=false');
    expect(snapshotUrl(scope, true)).toBe('/v1/sessions/pane%2Fsession/snapshot?live=true');
  });
});

describe('reading a pane snapshot', () => {
  it('returns the daemon text for a scope that belongs to the daemon', async () => {
    const seen: string[] = [];
    const text = await readPaneSnapshot(daemon, scope, undefined, async url => {
      seen.push(String(url));
      return new Response('$ bun test\nok');
    });
    expect(text).toBe('$ bun test\nok');
    expect(seen).toEqual(['https://pane.example.test/v1/sessions/pane%2Fsession/snapshot?live=false']);
  });

  it('refuses a scope belonging to another daemon rather than crossing the pair', async () => {
    await expect(readPaneSnapshot(other, scope, undefined, async () => new Response(''))).rejects.toThrow(
      'terminal scope must belong to the requested daemon',
    );
  });

  it('surfaces a structured daemon error', async () => {
    const failed = readPaneSnapshot(
      daemon,
      scope,
      undefined,
      async () =>
        new Response(JSON.stringify({ error: 'no such pane', code: 'gone' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(failed).rejects.toBeInstanceOf(DaemonResponseError);
    await expect(failed).rejects.toThrow('no such pane');
  });

  it('falls back to the status line when the daemon body is not a shaped error', async () => {
    await expect(
      readPaneSnapshot(daemon, scope, undefined, async () => new Response('boom', { status: 503 })),
    ).rejects.toThrow('HTTP 503');
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

  it('treats sub-pixel rounding at the end of the log as still pinned', () => {
    expect(isPinnedToBottom(1_000, 900, 100)).toBe(true);
    expect(isPinnedToBottom(1_000, 897, 100)).toBe(true);
    expect(isPinnedToBottom(1_000, 800, 100)).toBe(false);
  });
});
