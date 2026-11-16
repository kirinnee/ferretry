import { describe, expect, test } from 'bun:test';
import { ok } from '@ferretry/std';
import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import type { FerretId } from '../../../../contract/index.ts';
import { ferretId } from '../../../../contract/testing/index.ts';
import { markedHealth } from '../../../../daemon/lib/ferrets/health-mark.ts';
import { ferretsPort } from '../../../../daemon/lib/ferrets/port.ts';
import type { FerretSessionPort, FerretsService } from '../../../../daemon/lib/ferrets/service.ts';
import { additivesFixture } from './additives-fixture.ts';

/**
 * c58-55: the Warden's two additive Ferrets members. `ResumeOptions.replaceLiveTerminal` (one resume that replaces a live
 * pane) and `markStalled` (the `stalled` health mark). Both are the Warden's alone.
 */

const F1 = 'f1' as FerretId;

/** A service that records what reached it; the port is what is under test here. */
function spy() {
  const reached: { readonly member: string; readonly args: readonly unknown[] }[] = [];
  const note =
    (member: string, answer: unknown) =>
    async (...args: unknown[]) => {
      reached.push({ member, args });
      return answer;
    };
  const service = {
    resume: note('resume', ok(F1)),
    markStalled: note('markStalled', true),
  } as unknown as FerretsService;
  return { reached, port: (consumer: string) => ferretsPort(service, consumer) };
}

describe('c58-55 resume with replaceLiveTerminal is the Warden’s alone', () => {
  test('any other consumer is refused with a sentence, and nothing is resumed', async () => {
    const w = spy();
    for (const consumer of ['board', 'lessons', 'conversation', ''])
      expect(
        await w.port(consumer).resume(F1, undefined, { origin: PERSON_ORIGIN, replaceLiveTerminal: true }),
      ).toEqual({
        ok: false,
        error: { code: 'refused', reason: 'only the Warden replaces a live pane' },
      });
    expect(w.reached).toEqual([]);
  });

  test('the Warden’s is forwarded with the flag, and a plain resume from anyone carries none', async () => {
    const w = spy();
    const asked = { origin: PERSON_ORIGIN, automatic: true, actor: 'warden', replaceLiveTerminal: true } as const;
    expect((await w.port('warden').resume(F1, 'back', asked)).ok).toBe(true);
    expect((await w.port('board').resume(F1, 'back', { origin: PERSON_ORIGIN })).ok).toBe(true);
    // `false` is no request at all: it is not forwarded, so the service never sees a flag a consumer did not mean.
    expect((await w.port('board').resume(F1, 'back', { origin: PERSON_ORIGIN, replaceLiveTerminal: false })).ok).toBe(
      true,
    );
    expect(w.reached.map(r => r.args[2])).toEqual([asked, { origin: PERSON_ORIGIN }, { origin: PERSON_ORIGIN }]);
  });
});

describe('c58-55 markStalled is the Warden’s alone', () => {
  test('any other consumer is refused 403 forbidden, and nothing is marked', async () => {
    const w = spy();
    for (const consumer of ['board', 'lessons', 'conversation', ''])
      await expect(w.port(consumer).markStalled?.(F1, true)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    expect(w.reached).toEqual([]);
  });

  test('the Warden’s reaches the service, set and clear', async () => {
    const w = spy();
    expect(await w.port('warden').markStalled?.(F1, true)).toBe(true);
    expect(await w.port('warden').markStalled?.(F1, false)).toBe(true);
    expect(w.reached.map(r => [r.member, r.args])).toEqual([
      ['markStalled', [F1, true]],
      ['markStalled', [F1, false]],
    ]);
  });
});

describe('c58-55 the stalled mark is one field of the state document', () => {
  test('a live ferret is marked stalled and every other field survives', () => {
    const current = { status: 'running', health: 'healthy', promptReady: true };
    expect(markedHealth(current, true)).toEqual({ status: 'running', health: 'stalled', promptReady: true });
  });

  test('an unmarked, a stalled-already and an ended ferret change nothing when marked', () => {
    expect(markedHealth({ status: 'running', health: 'stalled' }, true)).toBeUndefined();
    for (const status of ['completed', 'failed', 'stalled', 'stopped'])
      expect(markedHealth({ status, health: 'healthy' }, true)).toBeUndefined();
    // A more telling mark is not overwritten.
    for (const health of ['crashed', 'rate_limited'])
      expect(markedHealth({ status: 'running', health }, true)).toBeUndefined();
  });

  test('a clear takes only a stalled mark off, back to healthy', () => {
    expect(markedHealth({ status: 'running', health: 'stalled', reason: 'x' }, false)).toEqual({
      status: 'running',
      health: 'healthy',
      reason: 'x',
    });
    expect(markedHealth({ status: 'running', health: 'waiting' }, false)).toBeUndefined();
    expect(markedHealth('not a document', false)).toBeUndefined();
  });
});

describe('c58-55 the service marks a live ferret through the session files', () => {
  function peer() {
    const writes: [string, boolean][] = [];
    const session = {
      markStalled: async (ferret: string, stalled: boolean) => {
        writes.push([ferret, stalled]);
        return true;
      },
    } as unknown as FerretSessionPort;
    return { writes, session };
  }

  test('a running ferret is marked and cleared; the answer is what the files answered', async () => {
    const { writes, session } = peer();
    const f = additivesFixture({ session, state: 'working' });
    expect(await f.api.markStalled?.(f.id, true)).toBe(true);
    expect(await f.api.markStalled?.(f.id, false)).toBe(true);
    expect(writes).toEqual([
      [f.id, true],
      [f.id, false],
    ]);
  });

  test('a stopped or unknown ferret is a no-op that answers false, and writes nothing', async () => {
    const { writes, session } = peer();
    const f = additivesFixture({ session });
    expect(await f.api.markStalled?.(f.id, true)).toBe(false);
    expect(await f.api.markStalled?.(ferretId('nobody'), true)).toBe(false);
    expect(writes).toEqual([]);
  });

  test('a Ferrets with no session files marks nothing', async () => {
    const f = additivesFixture({ state: 'working' });
    expect(await f.api.markStalled?.(f.id, true)).toBe(false);
  });
});
