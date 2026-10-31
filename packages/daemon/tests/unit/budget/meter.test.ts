import { describe, it } from 'bun:test';
import should from 'should';
import type { AnalyticsTokenUsage } from '../../../src/lib/analytics/pricing.ts';
import { foldAnalyticsSessionUsage } from '../../../src/lib/analytics/usage-fold.ts';
import { type MeteredSession, SpendMeter } from '../../../src/lib/budget/meter.ts';
import { spendRecords } from '../../../src/lib/budget/spend-fold.ts';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptHarness,
  TranscriptWindow,
} from '../../../src/lib/transcript/types.ts';

type UsageFigures = Extract<TranscriptEvent, { kind: 'usage' }>['usage'];

const usage = (
  at: string,
  figures: UsageFigures,
  extra: { readonly messageId?: string; readonly harness?: TranscriptHarness } = {},
): TranscriptEvent => ({
  harness: extra.harness ?? 'claude',
  role: 'system',
  kind: 'usage',
  timestamp: at,
  ...(extra.messageId === undefined ? {} : { messageId: extra.messageId }),
  usage: figures,
});

/** One request: `output` output tokens on `model`, its cache write split given so it can be priced. */
const request = (at: string, output: number, messageId?: string, model = 'claude-opus-5-5'): TranscriptEvent =>
  usage(
    at,
    { inputTokens: 10, outputTokens: output, cacheCreationInputTokens: 0, cacheWrite5mInputTokens: 0, model },
    messageId === undefined ? {} : { messageId },
  );

describe('spendRecords', () => {
  it('should count each record at its own time, keep message ids, and skip a record with no timestamp', () => {
    const folded = spendRecords(
      [
        request('2026-10-30T01:00:00Z', 5, 'msg-1'),
        { harness: 'claude', role: 'system', kind: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { harness: 'claude', role: 'assistant', kind: 'message', text: 'hello' },
      ],
      'claude',
      {},
    );
    should(folded.records).have.length(1);
    should(folded.records[0]).match({ atMs: Date.parse('2026-10-30T01:00:00Z'), messageId: 'msg-1' });
    should(folded.records[0]?.usage).match({ pricingModel: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5 });
  });

  it('should carry Codex’s model and running total from one read to the next', () => {
    const first = spendRecords(
      [
        { harness: 'codex', role: 'system', kind: 'settings', settings: { model: 'gpt-6' } },
        usage(
          '2026-10-30T01:00:00Z',
          { inputTokens: 100, outputTokens: 10, sessionTotalTokens: 110 },
          { harness: 'codex' },
        ),
      ],
      'codex',
      {},
    );
    should(first.carry).eql({ turnModel: 'gpt-6', runningTotal: 110 });
    // The same running total again is the previous request restated, not a new one.
    const second = spendRecords(
      [
        usage(
          '2026-10-30T01:01:00Z',
          { inputTokens: 100, outputTokens: 10, sessionTotalTokens: 110 },
          { harness: 'codex' },
        ),
        usage(
          '2026-10-30T01:02:00Z',
          { inputTokens: 50, outputTokens: 5, sessionTotalTokens: 165 },
          { harness: 'codex' },
        ),
      ],
      'codex',
      first.carry,
    );
    should(second.records).have.length(1);
    should(second.records[0]?.usage).match({ pricingModel: 'gpt-6', inputTokens: 50 });
  });

  it('should add up to the same tokens the analytics fold bills for a finished session', () => {
    // Claude writes one line per content block, each repeating the message's usage: the last one speaks.
    const events = [
      request('2026-10-30T01:00:00Z', 3, 'msg-1'),
      request('2026-10-30T01:00:01Z', 7, 'msg-1'),
      request('2026-10-30T01:05:00Z', 11, 'msg-2'),
    ];
    const fold = foldAnalyticsSessionUsage({ kind: 'read', harness: 'claude', events, issues: [], pendingBytes: 0 });
    const lastPerMessage = new Map<string, AnalyticsTokenUsage>();
    for (const record of spendRecords(events, 'claude', {}).records) {
      lastPerMessage.set(record.messageId as string, record.usage as AnalyticsTokenUsage);
    }
    const sum = (key: 'inputTokens' | 'outputTokens') =>
      [...lastPerMessage.values()].reduce((total, entry) => total + (entry[key] ?? 0), 0);
    should(fold.kind).equal('usage');
    if (fold.kind !== 'usage') return;
    should(sum('inputTokens')).equal(fold.usage.inputTokens);
    should(sum('outputTokens')).equal(fold.usage.outputTokens);
  });
});

/** A transcript that grows: each `next()` hands back what was appended since. */
class GrowingTranscript {
  readonly pending: TranscriptEvent[][] = [];
  reset = false;
  gone = false;
  /** The issues the next step's batch reports. */
  issues: { readonly code: string }[] = [];
  constructor(readonly harness: 'claude' | 'codex' = 'claude') {}
  append(...events: TranscriptEvent[]): void {
    this.pending.push(events);
  }
  window(file: string): TranscriptWindow {
    return {
      file,
      next: async () => {
        if (this.gone) throw new Error('no such file');
        const events = this.pending.shift();
        if (events === undefined) return { more: false };
        const reset = this.reset;
        this.reset = false;
        const issues = this.issues;
        this.issues = [];
        return {
          batch: { harness: this.harness, file, reset, events, issues } as unknown as TranscriptBatch,
          more: this.pending.length > 0,
        };
      },
    };
  }
}

/** One micro-dollar per output token; a model called `unpriced` has no price. */
const price = (entry: AnalyticsTokenUsage): number | undefined =>
  entry.pricingModel === 'unpriced' ? undefined : (entry.outputTokens ?? 0);

function meterOver(
  sessions: MeteredSession[],
  files: Record<string, GrowingTranscript>,
  byId: Record<string, string[]>,
) {
  const opened: string[] = [];
  const meter = new SpendMeter({
    sessions: async () => sessions,
    files: async session => (byId[session.id] ?? []).map(path => ({ path, harness: files[path]?.harness ?? 'claude' })),
    window: (file, _harness, sinceIso) => {
      opened.push(`${file}@${sinceIso}`);
      return (files[file] as GrowingTranscript).window(file);
    },
    pricing: async () => price,
  });
  return { meter, opened };
}

const WEEK = Date.parse('2026-10-26T00:00:00Z');
const DAY = { start: Date.parse('2026-10-30T00:00:00Z'), end: Date.parse('2026-10-31T00:00:00Z') };
const LIFTOFF = new Set(['claude-liftoff']);

describe('SpendMeter', () => {
  it('should book each request to the day it was made, across a running session that crossed midnight', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-29T23:50:00Z', 100, 'a'), request('2026-10-30T00:10:00Z', 30, 'b'));
    const { meter, opened } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { main },
      { s1: ['main'] },
    );
    should(meter.measured).be.false();
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.measured).be.true();
    should(opened).eql(['main@2026-10-26T00:00:00.000Z']);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end)).eql({ usdMicros: 30, unpriced: 0, partial: false });
    should(meter.spent(LIFTOFF, WEEK, DAY.end)).eql({ usdMicros: 130, unpriced: 0, partial: false });

    // The session keeps running: only what it appended is read, and the window is not opened again.
    main.append(request('2026-10-30T09:00:00Z', 5, 'c'));
    await meter.refresh(WEEK, LIFTOFF);
    should(opened).have.length(1);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(35);
  });

  it('should replace an earlier line of the same message, even one read in an earlier step', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 3, 'm'));
    const { meter } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    main.append(request('2026-10-30T01:00:02Z', 9, 'm'));
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(9);
  });

  it("should count a sub-agent's transcript, and a message a fork copied only once", async () => {
    const main = new GrowingTranscript();
    const sub = new GrowingTranscript();
    const fork = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 10, 'm1'));
    sub.append(request('2026-10-30T01:01:00Z', 20, 's1'));
    fork.append(request('2026-10-30T01:00:00Z', 10, 'm1'), request('2026-10-30T02:00:00Z', 4, 'f1'));
    const { meter } = meterOver(
      [
        { id: 'parent', harness: 'claude', agent: 'claude-liftoff', moves: [] },
        { id: 'child', harness: 'claude', agent: 'claude-liftoff', moves: [] },
      ],
      { main, sub, fork },
      { parent: ['main', 'sub'], child: ['fork'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(34);
  });

  it('should book what a migrated session did before the move to the login it moved from', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 50, 'before'), request('2026-10-30T03:00:00Z', 7, 'after'));
    const { meter } = meterOver(
      [
        {
          id: 's1',
          harness: 'claude',
          agent: 'claude-home',
          moves: [{ from: 'claude-liftoff', atMs: Date.parse('2026-10-30T02:00:00Z') }],
        },
      ],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, new Set(['claude-liftoff', 'claude-home']));
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(50);
    should(meter.spent(new Set(['claude-home']), DAY.start, DAY.end).usdMicros).equal(7);
  });

  it('should book every stretch of a session moved twice to the login it ran on then', async () => {
    // Moved liftoff → home at 02:00 and home → work at 04:00: before the first move is liftoff's, between the
    // moves home's, after them work's. With only the last move kept, liftoff's 50 was booked to home.
    const main = new GrowingTranscript();
    main.append(
      request('2026-10-30T01:00:00Z', 50, 'on-liftoff'),
      request('2026-10-30T03:00:00Z', 7, 'on-home'),
      request('2026-10-30T05:00:00Z', 2, 'on-work'),
    );
    const { meter } = meterOver(
      [
        {
          id: 's1',
          harness: 'claude',
          agent: 'claude-work',
          moves: [
            { from: 'claude-liftoff', atMs: Date.parse('2026-10-30T02:00:00Z') },
            { from: 'claude-home', atMs: Date.parse('2026-10-30T04:00:00Z') },
          ],
        },
      ],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, new Set(['claude-liftoff']));
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(50);
    should(meter.spent(new Set(['claude-home']), DAY.start, DAY.end).usdMicros).equal(7);
    should(meter.spent(new Set(['claude-work']), DAY.start, DAY.end).usdMicros).equal(2);
  });

  it('should keep the spend of a conversation converted to another harness, from the file it left', async () => {
    // A convert rebinds the session to a new Codex transcript with none of the Claude usage records; the
    // Claude file is still named (as the conversion's source) and keeps its spend on liftoff.
    const claude = new GrowingTranscript('claude');
    const codex = new GrowingTranscript('codex');
    claude.append(request('2026-10-30T01:00:00Z', 50, 'c1'));
    const byId: Record<string, string[]> = { s1: ['claude'] };
    const sessions: MeteredSession[] = [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }];
    const { meter } = meterOver(sessions, { claude, codex }, byId);
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(50);
    // Converted at 02:00 onto codex-a.
    sessions[0] = {
      id: 's1',
      harness: 'codex',
      agent: 'codex-a',
      moves: [{ from: 'claude-liftoff', atMs: Date.parse('2026-10-30T02:00:00Z') }],
    };
    byId.s1 = ['codex', 'claude'];
    codex.append(
      usage('2026-10-30T03:00:00Z', { inputTokens: 0, outputTokens: 6, model: 'gpt-6' }, { harness: 'codex' }),
    );
    await meter.refresh(WEEK, new Set(['claude-liftoff', 'codex-a']));
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(50);
    should(meter.spent(new Set(['codex-a']), DAY.start, DAY.end).usdMicros).equal(6);
    // Even once the old file is no longer named at all, what it booked stays to the end of the period.
    byId.s1 = ['codex'];
    await meter.refresh(WEEK, new Set(['claude-liftoff', 'codex-a']));
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(50);
  });

  it('should say the amount is partial when a window could not reach back to the start of the period', async () => {
    const main = new GrowingTranscript();
    main.issues = [{ code: 'window-capped' }];
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'));
    const { meter } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end)).eql({ usdMicros: 10, unpriced: 0, partial: true });
    should(meter.spent(new Set(['claude-home']), DAY.start, DAY.end).partial).be.false();
  });

  it('should count a request with no price apart, never as $0, and ignore other logins', async () => {
    const main = new GrowingTranscript();
    const other = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'), request('2026-10-30T01:01:00Z', 99, 'b', 'unpriced'));
    other.append(request('2026-10-30T01:00:00Z', 1_000, 'x'));
    const { meter } = meterOver(
      [
        { id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] },
        { id: 's2', harness: 'claude', agent: 'claude-home', moves: [] },
      ],
      { main, other },
      { s1: ['main'], s2: ['other'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end)).eql({ usdMicros: 10, unpriced: 1, partial: false });
  });

  it('should forget what a replaced file booked and read it again, and keep what a vanished file booked', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'));
    const { meter } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    main.reset = true;
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'), request('2026-10-30T02:00:00Z', 2, 'b'));
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(12);
    main.gone = true;
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(12);
  });

  it("should keep a rebound transcript's spend, count the copy in its new one once, and skip a file it cannot open", async () => {
    const old = new GrowingTranscript();
    const fresh = new GrowingTranscript();
    old.append(request('2026-10-30T01:00:00Z', 10, 'a'));
    fresh.append(request('2026-10-30T01:00:00Z', 10, 'a'), request('2026-10-30T02:00:00Z', 5, 'b'));
    const byId: Record<string, string[]> = { s1: ['old'] };
    const { meter } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { old, fresh },
      byId,
    );
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(10);
    byId.s1 = ['fresh'];
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(15);

    const broken = new SpendMeter({
      sessions: async () => [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      files: async () => [{ path: 'gone', harness: 'claude' as const }],
      window: () => {
        throw new Error('no reader');
      },
      pricing: async () => price,
    });
    await broken.refresh(WEEK, LIFTOFF);
    should(broken.spent(LIFTOFF, DAY.start, DAY.end)).eql({ usdMicros: 0, unpriced: 0, partial: false });
  });

  it('should keep what a session booked while its transcript cannot be named, and let go of an emptied one', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'));
    let failing = false;
    let listed = true;
    const meter = new SpendMeter({
      sessions: async () =>
        listed ? [{ id: 's1', harness: 'claude' as const, agent: 'claude-liftoff', moves: [] }] : [],
      files: async () => {
        if (failing) throw new Error('resolver hiccup');
        return [{ path: 'main', harness: 'claude' as const }];
      },
      window: file => main.window(file),
      pricing: async () => price,
    });
    await meter.refresh(WEEK, LIFTOFF);
    failing = true;
    await meter.refresh(WEEK, LIFTOFF);
    should(meter.spent(LIFTOFF, DAY.start, DAY.end).usdMicros).equal(10);
    // The session leaves the period and the week moves on: nothing it booked is left, so it is let go.
    failing = false;
    listed = false;
    await meter.refresh(Date.parse('2026-11-02T00:00:00Z'), LIFTOFF);
    should(meter.spent(LIFTOFF, WEEK, Date.parse('2026-11-09T00:00:00Z')).usdMicros).equal(0);
  });

  it('should drop what came before the period when the week moves on', async () => {
    const main = new GrowingTranscript();
    main.append(request('2026-10-30T01:00:00Z', 10, 'a'));
    const { meter } = meterOver(
      [{ id: 's1', harness: 'claude', agent: 'claude-liftoff', moves: [] }],
      { main },
      { s1: ['main'] },
    );
    await meter.refresh(WEEK, LIFTOFF);
    const nextWeek = Date.parse('2026-11-02T00:00:00Z');
    main.append(request('2026-11-02T01:00:00Z', 3, 'b'));
    await meter.refresh(nextWeek, LIFTOFF);
    should(meter.spent(LIFTOFF, WEEK, nextWeek + 7 * 86_400_000).usdMicros).equal(3);
  });
});
