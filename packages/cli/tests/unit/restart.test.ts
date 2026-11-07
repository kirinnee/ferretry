import { describe, it } from 'bun:test';
import should from 'should';
import {
  type Attempt,
  classifyUnreachable,
  DAEMON_STARTING_CODE,
  daemonStartingOf,
  restartBackoffMs,
  waitOutRestart,
} from '../../src/lib/restart.ts';

const refused: Attempt<string> = { kind: 'unreachable', how: 'refused', error: new Error('refused') };

describe('waiting out a restart', () => {
  it('should back off 250 ms, 500 ms, 1 s, then every 2 s', () => {
    should([0, 1, 2, 3, 9].map(restartBackoffMs)).deepEqual([250, 500, 1000, 2000, 2000]);
  });

  it('should classify refused and dropped connections and nothing else', () => {
    should(classifyUnreachable(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).equal('refused');
    should(classifyUnreachable({ cause: { code: 'ECONNRESET' } })).equal('dropped');
    should(classifyUnreachable(new Error('timeout'))).be.undefined();
  });

  it('should read the still-starting answer as a refusal, and leave every other response unread', async () => {
    const starting = Response.json({ error: 'reading grants', code: DAEMON_STARTING_CODE }, { status: 503 });
    should((await daemonStartingOf(starting))?.message).equal('reading grants');
    should(await daemonStartingOf(Response.json({}, { status: 200 }))).be.undefined();
    should(await daemonStartingOf(Response.json({ error: 'broken' }, { status: 503 }))).be.undefined();
  });

  it('should retry a refused connection until the daemon answers, saying it is waiting once', async () => {
    // Arrange
    let now = 0;
    let told = 0;
    const attempts: Attempt<string>[] = [refused, { kind: 'answered', value: 'back' }];

    // Act
    const outcome = await waitOutRestart({
      first: refused,
      attempt: async () => attempts.shift() as Attempt<string>,
      repeatable: false,
      patience: { expected: () => true, waiting: () => (told += 1) },
      nowMs: () => now,
      sleep: async ms => {
        now += ms;
      },
    });

    // Assert
    should(outcome).deepEqual({ kind: 'answered', value: 'back' });
    should(told).equal(1);
  });

  it('should not repeat a dropped request unless it is harmless to', async () => {
    const dropped: Attempt<string> = { kind: 'unreachable', how: 'dropped', error: new Error('reset') };
    const run = (repeatable: boolean) =>
      waitOutRestart({
        first: dropped,
        attempt: async () => ({ kind: 'answered', value: 'ok' }),
        repeatable,
        patience: { expected: () => true, waiting: () => undefined },
        nowMs: () => 0,
        sleep: async () => undefined,
      });
    should((await run(false)).kind).equal('unreachable');
    should((await run(true)).kind).equal('answered');
  });

  it('should give up when patience says a restart is not expected, or the window ends', async () => {
    let now = 0;
    const base = {
      first: refused,
      attempt: async () => refused,
      repeatable: true,
      nowMs: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    should((await waitOutRestart({ ...base, patience: { expected: () => false, waiting: () => undefined } })).kind).equal('unreachable');
    should((await waitOutRestart({ ...base, patience: { expected: () => true, waiting: () => undefined, windowMs: 1000 } })).kind).equal('unreachable');
    should(now).equal(1000);
    should((await waitOutRestart({ ...base, patience: undefined })).kind).equal('unreachable');
  });
});
