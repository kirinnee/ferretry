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

test('the last lines ride on the cause and end the reason; every cause it builds is one the record accepts', () => {
  const lastLines = 'error: out of memory\nexit';
  for (const exit of [{ signal: 9, lastLines }, { status: 3, lastLines }, { lastLines }, { status: 0, lastLines }]) {
    const end = endOfExit(exit);
    expect(FerretEndCauseSchema.safeParse(end.cause).success).toBe(true);
    expect(end.reason.endsWith(`Its last words: ${lastLines}`)).toBe(true);
  }
  expect(endOfExit({ signal: 9, lastLines }).cause).toEqual({ kind: 'signal', signal: 9, lastLines });
});
