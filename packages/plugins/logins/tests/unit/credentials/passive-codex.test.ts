/**
 * The Codex passive reading pass (§8.2.3): which ferret's rollout is a login's, when a rollout is read again, and what
 * is recorded. Every rollout is built in memory; nothing reads a real Codex home.
 */
import { describe, expect, test } from 'bun:test';
import type { CredentialSubject } from '../../../daemon/lib/credentials/credential-status.ts';
import {
  attributedSessions,
  CodexPassiveReading,
  type PassiveAssignment,
  type PassiveLogin,
  type PassiveSession,
  type PassiveTranscript,
} from '../../../daemon/lib/credentials/passive-codex.ts';
import type { PassiveUsageRecord } from '../../../daemon/lib/credentials/usage.ts';

const encoder = new TextEncoder();

const tokenCount = (timestamp: string, fiveHour: number): string =>
  `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { primary: { used_percent: fiveHour, window_minutes: 300, resets_at: 1_800_003_600 } },
    },
  })}\n`;

const at = (iso: string): number => Date.parse(iso);

/** A rollout that can be rewritten: `text` is what the ferret's file holds now. */
class Rollout {
  text: string;
  file = 'token-1';
  opens = 0;
  reads = 0;
  closed = 0;
  constructor(text: string) {
    this.text = text;
  }
  transcript(): PassiveTranscript {
    const bytes = encoder.encode(this.text);
    this.opens += 1;
    return {
      file: this.file,
      size: bytes.byteLength,
      mtimeMs: 1_700_000_000_000,
      read: async (offset, length) => {
        this.reads += 1;
        return bytes.slice(offset, offset + length);
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

const session = (
  id: string,
  rollout: Rollout | undefined,
  who: { readonly runtime?: string; readonly login?: string } = { runtime: 'codex-a' },
  stateAt = 0,
  current: PassiveSession['current'] = async () => who,
): PassiveSession => ({
  id,
  ...who,
  stateAt,
  current,
  open: async () => rollout?.transcript(),
});

/** Logins' own durable assignment record, in memory: it outlives a pass instance, as the file outlives a restart. */
class Assignments {
  held: Readonly<Record<string, PassiveAssignment>> = {};
  writes = 0;
  failWrites = false;
  read = async () => this.held;
  write = async (next: Readonly<Record<string, PassiveAssignment>>) => {
    if (this.failWrites) throw new Error('disk full');
    this.writes += 1;
    this.held = next;
  };
}

const subject = (id: string): CredentialSubject => ({
  id,
  resolution: { harness: 'codex', store: 'ferretry' } as never,
});
const login = (id: string, usedBy: readonly string[]): PassiveLogin => ({ subject: subject(id), usedBy });

function rig(
  logins: readonly PassiveLogin[],
  sessions: () => readonly PassiveSession[],
  assignments = new Assignments(),
) {
  const written: { readonly id: string; readonly record: PassiveUsageRecord }[] = [];
  let failWrite = false;
  const reading = new CodexPassiveReading({
    logins: async () => logins,
    sessions: async () => sessions(),
    assignments,
    now: () => 1_000,
    write: async (target, record) => {
      if (failWrite) throw new Error('disk full');
      written.push({ id: target.id, record });
    },
  });
  return {
    reading,
    written,
    assignments,
    failWrites: (fail: boolean) => {
      failWrite = fail;
    },
  };
}

describe('attributedSessions — only a ferret this daemon launched on the login', () => {
  const entry = { id: 'team', usedBy: ['codex-a', 'codex-b'] };

  test('names the ferrets on one of the login’s runtimes, and a login-named ferret by that login alone', () => {
    const sessions = [
      { id: '1', runtime: 'codex-a' },
      { id: '2', runtime: 'codex-b' },
      { id: '3', runtime: 'elsewhere' },
      { id: '4' },
      { id: '5', runtime: 'codex-a', login: 'team' },
      { id: '6', runtime: 'codex-a', login: 'another-login' },
    ];

    expect(attributedSessions(entry, sessions).map(each => each.id)).toEqual(['1', '2', '5']);
    expect(attributedSessions({ id: 'team', usedBy: [] }, sessions).map(each => each.id)).toEqual(['5']);
  });
});

describe('CodexPassiveReading', () => {
  test('records the newest reading of the login’s ferrets, from the one that measured last', async () => {
    const older = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 10));
    const newer = new Rollout(tokenCount('2026-10-13T08:00:00.000Z', 44));
    const unrelated = new Rollout(tokenCount('2026-10-13T09:00:00.000Z', 99));
    const sessions = [session('a', older), session('b', newer), session('c', unrelated, { runtime: 'not-this-login' })];
    const { reading, written } = rig([login('team', ['codex-a'])], () => sessions);

    await reading.pass();

    expect(written).toEqual([
      {
        id: 'team',
        record: {
          version: 1,
          source: 'codex-rollout',
          at: at('2026-10-13T08:00:00.000Z'),
          fiveHour: { usedPercent: 44, resetAt: 1_800_003_600_000 },
        },
      },
    ]);
    expect(unrelated.opens).toBe(0);
    expect(newer.closed).toBe(1);
  });

  test('reads a rollout again only when its stamp moved, and records only a newer reading', async () => {
    const rollout = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 10));
    const { reading, written } = rig([login('team', ['codex-a'])], () => [session('a', rollout)]);

    await reading.pass();
    const readsAfterFirst = rollout.reads;
    await reading.pass();
    expect(rollout.reads).toBe(readsAfterFirst);
    expect(written).toHaveLength(1);

    rollout.text += tokenCount('2026-10-13T07:30:00.000Z', 25);
    await reading.pass();
    expect(rollout.reads).toBeGreaterThan(readsAfterFirst);
    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([10, 25]);

    rollout.text = tokenCount('2026-10-13T07:15:00.000Z', 99);
    await reading.pass();
    expect(written).toHaveLength(2);
  });

  test('reads a replaced file again even when its size and time did not move', async () => {
    const rollout = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 10));
    const { reading, written } = rig([login('team', ['codex-a'])], () => [session('a', rollout)]);
    await reading.pass();

    rollout.file = 'token-2';
    rollout.text = tokenCount('2026-10-13T07:45:00.000Z', 31);
    await reading.pass();

    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([10, 31]);
  });

  test('keeps a ferret whose rollout is unproved or unreadable for the next pass', async () => {
    const readable = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 12));
    let proved = false;
    const flaky: PassiveSession = {
      id: 'flaky',
      runtime: 'codex-a',
      stateAt: 0,
      current: async () => ({ runtime: 'codex-a' }),
      open: async () => {
        if (!proved) throw new Error('refused');
        return readable.transcript();
      },
    };
    const broken: PassiveSession = {
      id: 'broken',
      runtime: 'codex-a',
      stateAt: 0,
      current: async () => ({ runtime: 'codex-a' }),
      open: async () => ({
        file: 'x',
        size: 10,
        mtimeMs: 1,
        read: async () => {
          throw new Error('replaced');
        },
        close: async () => {
          throw new Error('already closed');
        },
      }),
    };
    const unproved = session('unproved', undefined);
    const { reading, written } = rig([login('team', ['codex-a'])], () => [flaky, broken, unproved]);

    await reading.pass();
    expect(written).toEqual([]);

    proved = true;
    await reading.pass();
    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([12]);
  });

  test('tries a reading again next pass when recording it failed, and lets the other logins go on', async () => {
    const team = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 10));
    const home = new Rollout(tokenCount('2026-10-13T07:10:00.000Z', 20));
    const sessions = [session('a', team), session('b', home, { runtime: 'codex-home' })];
    const { reading, written, failWrites } = rig(
      [login('team', ['codex-a']), login('home', ['codex-home'])],
      () => sessions,
    );

    failWrites(true);
    await reading.pass();
    expect(written).toEqual([]);

    failWrites(false);
    await reading.pass();
    expect(written.map(entry => entry.id)).toEqual(['team', 'home']);
  });

  test('forgets a ferret that is gone, so a new one on the same id is read afresh', async () => {
    const rollout = new Rollout(tokenCount('2026-10-13T07:00:00.000Z', 10));
    let live: readonly PassiveSession[] = [session('a', rollout)];
    const { reading, written } = rig([login('team', ['codex-a'])], () => live);
    await reading.pass();

    live = [];
    await reading.pass();
    live = [session('a', rollout)];
    await reading.pass();

    expect(rollout.opens).toBe(2);
    expect(written).toHaveLength(1);
  });

  test('does not look at a single ferret while no Codex login is signed in on this machine', async () => {
    let asked = 0;
    const reading = new CodexPassiveReading({
      logins: async () => [],
      sessions: async () => {
        asked += 1;
        return [];
      },
      assignments: new Assignments(),
      now: () => 0,
      write: async () => undefined,
    });

    await reading.pass();

    expect(asked).toBe(0);
  });
});

describe('CodexPassiveReading — a carried rollout never puts the old login’s quota on the new login', () => {
  const heavy = tokenCount('2026-10-13T08:00:00.000Z', 99);
  const moved = at('2026-10-13T08:30:00.000Z');
  const taskStarted = `${JSON.stringify({ timestamp: '2026-10-13T08:31:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`;

  test('a move from login A to login B: A keeps its reading, and B gets none from the carried rollout', async () => {
    const rollout = new Rollout(heavy);
    let ferret: PassiveSession = session('f', rollout, { login: 'a' });
    const { reading, written } = rig([login('a', []), login('b', [])], () => [ferret]);
    await reading.pass();
    expect(written.map(entry => entry.id)).toEqual(['a']);

    // The move: the same conversation, now started on B at 08:30; Codex appends a turn start and no token_count yet.
    rollout.text += taskStarted;
    ferret = session('f', rollout, { login: 'b' }, moved);
    await reading.pass();
    await reading.pass();

    expect(written.map(entry => entry.id)).toEqual(['a']);
  });

  test('B records the first reading Codex takes on B, and one taken at the very instant it started', async () => {
    const rollout = new Rollout(heavy + taskStarted);
    const { reading, written } = rig([login('b', [])], () => [session('f', rollout, { login: 'b' }, moved)]);
    await reading.pass();
    expect(written).toEqual([]);

    rollout.text += tokenCount('2026-10-13T08:30:00.000Z', 3);
    await reading.pass();
    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([3]);
  });

  test('a fork on login B does not take the source ferret’s readings carried in its copied rollout', async () => {
    const copied = new Rollout(heavy);
    const { reading, written } = rig([login('b', [])], () => [session('fork', copied, { login: 'b' }, moved)]);

    await reading.pass();

    expect(written).toEqual([]);
  });

  test('a daemon restart rereads the historical rollout and still refuses what predates the current login', async () => {
    const rollout = new Rollout(heavy + taskStarted);
    const live = () => [session('f', rollout, { login: 'b' }, moved)];
    const first = rig([login('b', [])], live);
    await first.reading.pass();
    // A brand new pass instance holds no memory of what the first one saw.
    const restarted = rig([login('b', [])], live);
    await restarted.reading.pass();

    expect(first.written).toEqual([]);
    expect(restarted.written).toEqual([]);
  });

  test('a ferret naming no login (the runtime default) is held to the same instant', async () => {
    const rollout = new Rollout(heavy + taskStarted);
    const { reading, written } = rig([login('b', ['codex-b'])], () => [
      session('f', rollout, { runtime: 'codex-b' }, moved),
    ]);

    await reading.pass();
    expect(written).toEqual([]);

    rollout.text += tokenCount('2026-10-13T09:00:00.000Z', 8);
    await reading.pass();
    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([8]);
  });
});

describe('CodexPassiveReading — the login assignment is Logins’ own record, not the ferret’s stateAt', () => {
  const turn = (minute: number, used: number): string => tokenCount(`2026-10-13T08:0${String(minute)}:00.000Z`, used);

  test('three short turns on login A, each followed by an idle change a millisecond later: A shows the last one', async () => {
    const rollout = new Rollout(turn(1, 1));
    let stateAt = at('2026-10-13T08:00:00.000Z');
    const { reading, written } = rig([login('a', [])], () => [session('f', rollout, { login: 'a' }, stateAt)]);
    await reading.pass();
    for (const [minute, used] of [
      [2, 20],
      [3, 50],
      [4, 99],
    ] as const) {
      rollout.text += turn(minute, used);
      stateAt = at(`2026-10-13T08:0${String(minute)}:00.001Z`);
      await reading.pass();
    }

    expect(written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([1, 20, 50, 99]);
  });

  test('keeps its first `since` while the login is the same, moves it on a different login, and writes only a change', async () => {
    const rollout = new Rollout(turn(1, 1));
    let who = { login: 'a' };
    let stateAt = at('2026-10-13T08:00:00.000Z');
    const { reading, assignments } = rig([login('a', []), login('b', [])], () => [session('f', rollout, who, stateAt)]);
    await reading.pass();
    expect(assignments.held).toEqual({ f: { login: 'a', since: at('2026-10-13T08:00:00.000Z') } });

    stateAt = at('2026-10-13T08:09:00.000Z');
    await reading.pass();
    expect(assignments.writes).toBe(1);

    who = { login: 'b' };
    await reading.pass();
    expect(assignments.held).toEqual({ f: { login: 'b', since: at('2026-10-13T08:09:00.000Z') } });
    expect(assignments.writes).toBe(2);
  });

  test('forgets a ferret that is gone, takes now for one with no stateAt, and one with no login or runtime is never attributed', async () => {
    const rollout = new Rollout(turn(1, 1));
    let live: readonly PassiveSession[] = [
      session('f', rollout, { login: 'a' }, Number.NaN),
      session('g', rollout, {}, 5),
    ];
    const { reading, assignments } = rig([login('a', [])], () => live);
    await reading.pass();
    expect(assignments.held).toEqual({ f: { login: 'a', since: 1_000 } });

    live = [];
    await reading.pass();
    expect(assignments.held).toEqual({});
  });

  test('survives a restart: the record read back keeps the first instant, so a later idle change cannot lose a reading', async () => {
    const rollout = new Rollout(turn(1, 1));
    const shared = new Assignments();
    const first = rig(
      [login('a', [])],
      () => [session('f', rollout, { login: 'a' }, at('2026-10-13T08:00:00.000Z'))],
      shared,
    );
    await first.reading.pass();

    rollout.text += turn(2, 77);
    const restarted = rig(
      [login('a', [])],
      () => [session('f', rollout, { login: 'a' }, at('2026-10-13T08:02:00.001Z'))],
      shared,
    );
    await restarted.reading.pass();

    expect(restarted.written.map(entry => entry.record.fiveHour?.usedPercent)).toEqual([77]);
    expect(shared.writes).toBe(1);
  });

  test('tries the record again next pass when writing it failed, with the instant it already chose', async () => {
    const rollout = new Rollout(turn(1, 1));
    let stateAt = at('2026-10-13T08:00:00.000Z');
    const { reading, assignments } = rig([login('a', [])], () => [session('f', rollout, { login: 'a' }, stateAt)]);
    assignments.failWrites = true;
    await reading.pass();
    expect(assignments.held).toEqual({});

    assignments.failWrites = false;
    stateAt = at('2026-10-13T08:05:00.000Z');
    await reading.pass();
    expect(assignments.held).toEqual({ f: { login: 'a', since: at('2026-10-13T08:00:00.000Z') } });
  });
});

describe('CodexPassiveReading — a reading is the login’s only if the ferret stayed on it while it was read', () => {
  test('a move to B while the transcript is opened records nothing for A, and B gets its reading on its own next pass', async () => {
    const rollout = new Rollout(tokenCount('2026-10-13T08:31:00.000Z', 3));
    let now: { login: string } = { login: 'a' };
    let stateAt = at('2026-10-13T08:00:00.000Z');
    const ferret = () => session('f', rollout, { login: now.login }, stateAt, async () => now);
    const listed = ferret();
    const moving: PassiveSession = {
      ...listed,
      open: async () => {
        now = { login: 'b' };
        stateAt = at('2026-10-13T08:30:00.000Z');
        return await listed.open();
      },
    };
    let calls = 0;
    const { reading, written } = rig([login('a', []), login('b', [])], () => (calls++ === 0 ? [moving] : [ferret()]));

    await reading.pass();
    expect(written).toEqual([]);

    await reading.pass();
    expect(written.map(entry => entry.id)).toEqual(['b']);
  });

  test('a ferret that is gone or stopped by the time it was read yields nothing, and is tried again', async () => {
    const rollout = new Rollout(tokenCount('2026-10-13T08:31:00.000Z', 3));
    let gone = true;
    const { reading, written } = rig([login('a', [])], () => [
      session('f', rollout, { login: 'a' }, 0, async () => (gone ? undefined : { login: 'a' })),
    ]);

    await reading.pass();
    expect(written).toEqual([]);

    gone = false;
    await reading.pass();
    expect(written.map(entry => entry.id)).toEqual(['a']);
  });
});

describe('CodexPassiveReading — only a reading with its own timestamp is attributed', () => {
  test('A’s carried 99% without a timestamp is not B’s after a later append moved the file time', async () => {
    const unstamped = `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 99 } } } })}\n`;
    const rollout = new Rollout(unstamped);
    const { reading, written } = rig([login('b', [])], () => [
      session('f', rollout, { login: 'b' }, at('2026-10-13T08:30:00.000Z')),
    ]);
    await reading.pass();
    rollout.text += `${JSON.stringify({ timestamp: '2026-10-13T08:31:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })}\n`;
    await reading.pass();

    expect(written).toEqual([]);
  });
});
