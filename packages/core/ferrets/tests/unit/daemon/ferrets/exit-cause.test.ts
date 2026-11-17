import { expect, test } from 'bun:test';
import { FerretEndCauseSchema } from '../../../../contract/index.ts';
import { endOfExit } from '../../../../daemon/lib/ferrets/exit-cause.ts';

test('a signal is a signal, never an invented exit code', () => {
  const end = endOfExit({ signal: 9 });
  expect(end).toEqual({
    cause: { kind: 'signal', signal: 9 },
    status: 'failed',
    reason: 'the agent was ended by signal 9',
  });
});

test('a signal wins over a status tmux also printed', () => {
  expect(endOfExit({ signal: 15, status: 1 }).cause).toEqual({ kind: 'signal', signal: 15 });
});

test('a non-zero status is agent_crashed with the number', () => {
  expect(endOfExit({ status: 137 })).toMatchObject({
    cause: { kind: 'agent_crashed', exitCode: 137 },
    status: 'failed',
  });
});

test('status 0 is a clean exit (done, not a death)', () => {
  expect(endOfExit({ status: 0 })).toMatchObject({ cause: { kind: 'clean_exit' }, status: 'stopped' });
});

test('no recorded end is terminal_gone and says so', () => {
  const end = endOfExit({});
  expect(end.cause).toEqual({ kind: 'terminal_gone' });
  expect(end.reason).toBe('the agent exited on its own; how it exited was not recorded');
});

test('every cause it builds is one the record accepts, and none carries a screen: a stray `lastLines` is dropped and the record refuses one', () => {
  const lastLines = 'error: out of memory\nexit';
  for (const exit of [{ signal: 9 }, { status: 3 }, {}, { status: 0 }]) {
    // Whatever else rides on the answer (a runner from before this change), only the signal or status is read.
    const end = endOfExit({ ...exit, lastLines } as never);
    expect(FerretEndCauseSchema.safeParse(end.cause).success).toBe(true);
    expect(JSON.stringify(end)).not.toContain('out of memory');
  }
  expect(endOfExit({ signal: 9 }).cause).toEqual({ kind: 'signal', signal: 9 });
  expect(FerretEndCauseSchema.safeParse({ kind: 'signal', signal: 9, lastLines }).success).toBe(false);
});
