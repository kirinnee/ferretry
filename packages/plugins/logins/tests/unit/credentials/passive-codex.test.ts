/**
 * The Codex passive reading pass (§8.2.3): which ferret's rollout is a login's, when a rollout is read again, and what
 * is recorded. Every rollout is built in memory; nothing reads a real Codex home.
 */
import { describe, expect, test } from 'bun:test';
import type { CredentialSubject } from '../../../daemon/lib/credentials/credential-status.ts';
import {
  attributedSessions,
  CodexPassiveReading,
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
): PassiveSession => ({
  id,
  ...who,
  open: async () => rollout?.transcript(),
});

const subject = (id: string): CredentialSubject => ({
  id,
  resolution: { harness: 'codex', store: 'ferretry' } as never,
});
const login = (id: string, usedBy: readonly string[]): PassiveLogin => ({ subject: subject(id), usedBy });

function rig(logins: readonly PassiveLogin[], sessions: () => readonly PassiveSession[]) {
  const written: { readonly id: string; readonly record: PassiveUsageRecord }[] = [];
  let failWrite = false;
  const reading = new CodexPassiveReading({
    logins: async () => logins,
    sessions: async () => sessions(),
    write: async (target, record) => {
      if (failWrite) throw new Error('disk full');
      written.push({ id: target.id, record });
    },
  });
  return {
    reading,
    written,
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
      open: async () => {
        if (!proved) throw new Error('refused');
        return readable.transcript();
      },
    };
    const broken: PassiveSession = {
      id: 'broken',
      runtime: 'codex-a',
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
      write: async () => undefined,
    });

    await reading.pass();

    expect(asked).toBe(0);
  });
});
