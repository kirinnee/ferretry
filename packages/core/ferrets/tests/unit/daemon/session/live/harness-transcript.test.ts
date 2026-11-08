/** U5: a ferret's transcript through the harness that wrote it (`HarnessTranscript`), and the polled hub for its changes. */
import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import type { HarnessTailRecord } from '../../../../../contract/index.ts';
import { FakeHarness } from '../../../../../contract/testing/index.ts';
import { eventOfRecord, HarnessTranscript } from '../../../../../daemon/adapters/session/live/harness-transcript.ts';
import {
  PolledTranscriptEvents,
  TRANSCRIPT_POLL_MS,
} from '../../../../../daemon/adapters/session/live/polled-transcript-events.ts';
import type { SessionId } from '../../../../../daemon/lib/session-id.ts';
import { transcriptTurnPhase } from '../../../../../daemon/lib/session/peers/turn.ts';
import { transcriptUsageLimit } from '../../../../../daemon/lib/session/peers/turn.ts';

const FERRET = 'wren-1' as FerretId;
const AT = '2026-11-08T10:00:00.000Z' as HarnessTailRecord['at'];

function world(harness: FakeHarness | undefined = new FakeHarness()) {
  return {
    harness,
    transcript: new HarnessTranscript(
      () => harness,
      () => 'claude-code',
    ),
  };
}

describe('HarnessTranscript (U5)', () => {
  test('a ferret whose harness proves no transcript reads as unresolved, and a harness with no tail offers none', async () => {
    const { transcript } = world();
    expect(await transcript.tail.tail(FERRET, 10)).toEqual({ kind: 'unresolved' });
    expect(await transcript.reads.transcriptFile(FERRET as unknown as SessionId)).toBeUndefined();

    const none = new HarnessTranscript(
      () => ({ ...new FakeHarness(), transcriptTail: undefined, transcriptStamp: undefined }) as never,
      () => 'claude-code',
    );
    expect(await none.tail.tail(FERRET, 10)).toEqual({ kind: 'unresolved' });
  });

  test('the records become the events the turn fold reads: the newest one decides who has the turn', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, {
      stamp: { file: '/t/a.jsonl', size: 5, mtimeMs: 7 },
      records: [
        { kind: 'message', role: 'user', at: AT },
        { kind: 'work', at: AT },
      ],
    });
    const working = await transcript.tail.tail(FERRET, 10);
    if (working.kind !== 'read') throw new Error('read');
    expect(transcriptTurnPhase(working.events)).toBe('working');

    harness.transcripts.set(FERRET, {
      stamp: { file: '/t/a.jsonl', size: 9, mtimeMs: 8 },
      records: [
        { kind: 'work', at: AT },
        { kind: 'turn', state: 'completed', at: AT },
      ],
    });
    const ended = await transcript.tail.tail(FERRET, 10);
    if (ended.kind !== 'read') throw new Error('read');
    expect(transcriptTurnPhase(ended.events)).toBe('ended');
  });

  test('G161 no record becomes text: every message and work event is empty of words', () => {
    const records: HarnessTailRecord[] = [
      { kind: 'message', role: 'assistant', at: AT },
      { kind: 'work', at: AT },
    ];
    for (const record of records) {
      const event = eventOfRecord('claude', record);
      expect('text' in event ? event.text : '').toBe('');
    }
  });

  test('a usage-limit error keeps its code and its short masked notice, and reads as a limit on the ended turn', () => {
    const events = [
      eventOfRecord('codex', { kind: 'turn', state: 'started', at: AT }),
      eventOfRecord('codex', { kind: 'turn', state: 'completed', at: AT }),
      eventOfRecord('codex', {
        kind: 'error',
        at: AT,
        code: 'usage_limit_exceeded',
        notice: 'You hit your usage limit.',
      }),
    ];
    expect(transcriptUsageLimit(events)).toMatchObject({ notice: 'You hit your usage limit.' });
  });

  test('a file asks the harness that owns it for its stamp, and a ferret that lost its transcript is forgotten', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, { stamp: { file: '/t/a.jsonl', size: 5, mtimeMs: 7 }, records: [] });
    const file = await transcript.reads.transcriptFile(FERRET as unknown as SessionId);
    expect(file).toBe('/t/a.jsonl');
    expect(await transcript.reads.transcriptStat('/t/a.jsonl')).toEqual({ size: 5, mtimeMs: 7 });
    expect(await transcript.reads.transcriptStat('/t/other.jsonl')).toBeUndefined();

    harness.transcripts.delete(FERRET);
    expect(await transcript.reads.transcriptStat('/t/a.jsonl')).toBeUndefined();
    expect(await transcript.reads.transcriptStat('/t/a.jsonl')).toBeUndefined();
  });
});

describe('HarnessTranscript tail cache (U5 fix1, RULING #27 Q4)', () => {
  const stampOf = (size: number, mtimeMs = size) => ({ file: '/t/a.jsonl', size, mtimeMs });
  const records: HarnessTailRecord[] = [
    { kind: 'message', role: 'user', at: AT },
    { kind: 'work', at: AT },
  ];

  test('J-0260 a transcript that has not moved is read and parsed once, however often the turn watch looks', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, { stamp: stampOf(5), records });
    for (let look = 0; look < 20; look += 1) {
      const read = await transcript.tail.tail(FERRET, 400);
      if (read.kind !== 'read') throw new Error('read');
      expect(read.events.length).toBe(2);
    }
    expect(harness.tailed.length).toBe(1);
  });

  test('J-0260 a moved stamp reads again, and a wider window than the cached one reads again', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, { stamp: stampOf(5), records });
    await transcript.tail.tail(FERRET, 10);
    await transcript.tail.tail(FERRET, 10);
    expect(harness.tailed.length).toBe(1);

    harness.transcripts.set(FERRET, {
      stamp: stampOf(9),
      records: [...records, { kind: 'turn', state: 'completed', at: AT }],
    });
    const moved = await transcript.tail.tail(FERRET, 10);
    if (moved.kind !== 'read') throw new Error('read');
    expect(transcriptTurnPhase(moved.events)).toBe('ended');
    expect(harness.tailed.length).toBe(2);

    await transcript.tail.tail(FERRET, 400);
    expect(harness.tailed.length).toBe(3);
    // A narrower ask is answered from the wider read, with exactly the newest events.
    const narrow = await transcript.tail.tail(FERRET, 1);
    if (narrow.kind !== 'read') throw new Error('read');
    expect(narrow.events.length).toBe(1);
    expect(harness.tailed.length).toBe(3);
  });

  test('J-0260 a transcript lost, or a ferret forgotten at its stop, keeps nothing: the next look reads afresh', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, { stamp: stampOf(5), records });
    await transcript.tail.tail(FERRET, 10);
    transcript.forget(FERRET);
    await transcript.tail.tail(FERRET, 10);
    expect(harness.tailed.length).toBe(2);

    harness.transcripts.delete(FERRET);
    expect(await transcript.tail.tail(FERRET, 10)).toEqual({ kind: 'unresolved' });
    harness.transcripts.set(FERRET, { stamp: stampOf(5), records });
    await transcript.tail.tail(FERRET, 10);
    expect(harness.tailed.length).toBe(4);
  });

  test('J-0240 a live sample costs ONE stamp: the file and its stat share the stamp the file took', async () => {
    const { transcript, harness } = world();
    harness.transcripts.set(FERRET, { stamp: stampOf(5), records });
    const id = FERRET as unknown as SessionId;
    const file = await transcript.reads.transcriptFile(id);
    expect(await transcript.reads.transcriptStat(file as string)).toEqual({ size: 5, mtimeMs: 5 });
    expect(harness.stamped.length).toBe(1);
    // The shared stamp is used once: the next sample takes its own.
    await transcript.reads.transcriptFile(id);
    expect(harness.stamped.length).toBe(2);
  });
});

describe('PolledTranscriptEvents (no faster than 1 s; K2 has no file watch)', () => {
  test('one timer per subscription tells its listener the path each second until it is closed', () => {
    const ticks: (() => void)[] = [];
    const stopped: number[] = [];
    const hub = new PolledTranscriptEvents((ms, tick) => {
      expect(ms).toBe(TRANSCRIPT_POLL_MS);
      ticks.push(tick);
      return () => void stopped.push(ticks.length);
    });
    const heard: string[] = [];
    const subscription = hub.subscribe('/t/a.jsonl', path => heard.push(path));
    ticks[0]?.();
    ticks[0]?.();
    expect(heard).toEqual(['/t/a.jsonl', '/t/a.jsonl']);
    subscription.close();
    subscription.close();
    expect(stopped).toEqual([1]);
    expect(TRANSCRIPT_POLL_MS).toBeGreaterThanOrEqual(500);
  });
});
