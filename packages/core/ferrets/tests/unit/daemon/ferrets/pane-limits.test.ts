import { describe, expect, test } from 'bun:test';
import { ferretId } from '../../../../contract/testing/index.ts';
import type { FerretRecord } from '../../../../contract/index.ts';
import { livePaneLimits, type PaneLimitSources } from '../../../../daemon/lib/ferrets/pane-limits.ts';

const NOW = Date.parse('2026-11-14T10:00:00Z');

const record = (id: string, extra: Partial<FerretRecord> = {}): FerretRecord =>
  ({ id, state: 'working', runtime: 'codex-main', login: 'codex-login', ...extra }) as unknown as FerretRecord;

const limited = (extra: Record<string, unknown> = {}) => ({
  id: 's',
  status: 'rate_limited',
  turn: 1,
  quota: { atLimit: true, limitNotice: "You've hit your usage limit", ...extra },
});

/** Sources over a few sessions: each id → its index status, its state document and its record. */
function sources(
  sessions: Record<string, { status: string; state?: unknown; record?: FerretRecord | undefined }>,
  nowMs = NOW,
): PaneLimitSources {
  return {
    sessions: () => Object.entries(sessions).map(([id, entry]) => ({ id, status: entry.status })),
    readState: async id => {
      const entry = sessions[id];
      if (entry?.state === undefined) throw new Error('no document');
      return entry.state;
    },
    record: id => sessions[id]?.record,
    nowMs: () => nowMs,
  };
}

describe('the limits live panes prove', () => {
  test('a live rate-limited ferret is one row carrying its login, runtime, the harness sentence and its spend kind', async () => {
    const limits = await livePaneLimits(
      sources({
        a: { status: 'rate_limited', state: limited({ retryAt: NOW + 60_000 }), record: record('a') },
        b: {
          status: 'rate_limited',
          state: limited({ unavailableReason: 'spend_limit', limitNotice: 'Monthly spend limit reached' }),
          record: record('b', { login: 'claude-login', runtime: 'claude-main' }),
        },
      }),
    );

    expect(limits).toEqual([
      {
        ferret: ferretId('a'),
        runtime: 'codex-main',
        login: 'codex-login',
        notice: "You've hit your usage limit",
        spend: false,
        retryAt: NOW + 60_000,
      },
      {
        ferret: ferretId('b'),
        runtime: 'claude-main',
        login: 'claude-login',
        notice: 'Monthly spend limit reached',
        spend: true,
      },
    ]);
  });

  test('a limit with no reset time holds for as long as the session is limited', async () => {
    const limits = await livePaneLimits(
      sources({ a: { status: 'rate_limited', state: limited(), record: record('a') } }, NOW + 86_400_000),
    );

    expect(limits.map(row => [row.ferret, row.retryAt])).toEqual([[ferretId('a'), undefined]]);
  });

  test('a limit ends when the session is released: its status is running again, or its ferret is stopped', async () => {
    const limits = await livePaneLimits(
      sources({
        running: { status: 'running', state: { id: 's', status: 'running', turn: 1 }, record: record('running') },
        stale: {
          // The index row has not caught up, but the document says the session is running again.
          status: 'rate_limited',
          state: { id: 's', status: 'running', turn: 2 },
          record: record('stale'),
        },
        stopped: { status: 'rate_limited', state: limited(), record: record('stopped', { state: 'stopped' }) },
        unknown: { status: 'rate_limited', state: limited(), record: undefined },
      }),
    );

    expect(limits).toEqual([]);
  });

  test('a limit ends when its reset time passes', async () => {
    const limits = await livePaneLimits(
      sources({ a: { status: 'rate_limited', state: limited({ retryAt: NOW - 1 }), record: record('a') } }),
    );

    expect(limits).toEqual([]);
  });

  test('a usage-limit dialog is the sentence when the quota records none, and a damaged document is no limit', async () => {
    const dialog = {
      id: 's',
      status: 'rate_limited',
      turn: 1,
      harnessDialog: {
        id: '0123456789abcdef',
        harness: 'codex',
        kind: 'usage-limit',
        title: 'Usage limit',
        body: "You've hit your limit.\nTry again later.",
        options: [],
        escape: 'close',
      },
    };
    const limits = await livePaneLimits(
      sources({
        dialog: { status: 'rate_limited', state: dialog, record: record('dialog') },
        broken: { status: 'rate_limited', state: { nonsense: true }, record: record('broken') },
        missing: { status: 'rate_limited', record: record('missing') },
        noWords: {
          status: 'rate_limited',
          state: { id: 's', status: 'rate_limited', turn: 1 },
          record: record('noWords'),
        },
      }),
    );

    expect(limits.map(row => [row.ferret, row.notice])).toEqual([[ferretId('dialog'), "You've hit your limit."]]);
  });

  test('a ferret whose record names no login is still reported, by its runtime', async () => {
    const { login: _login, ...noLogin } = record('a');
    const limits = await livePaneLimits(
      sources({ a: { status: 'rate_limited', state: limited(), record: noLogin as FerretRecord } }),
    );

    expect(limits).toEqual([
      { ferret: ferretId('a'), runtime: 'codex-main', notice: "You've hit your usage limit", spend: false },
    ]);
  });
});
