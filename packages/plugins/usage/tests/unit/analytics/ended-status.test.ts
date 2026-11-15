import { describe, it } from 'bun:test';
import type { FerretEndCause } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { endedStatus, type EndedStatus, type WatchedOutcome } from '../../../daemon/lib/analytics/ended-status.ts';

describe('endedStatus', () => {
  it('should read a persisted cause as it ended, whatever this process watched', () => {
    const cases: readonly (readonly [FerretEndCause, EndedStatus])[] = [
      [{ kind: 'completed' }, 'completed'],
      [{ kind: 'stopped' }, 'stopped'],
      [{ kind: 'clean_exit' }, 'stopped'],
      [{ kind: 'tmux_crashed' }, 'failed'],
      [{ kind: 'terminal_gone' }, 'failed'],
      [{ kind: 'signal', signal: 9 }, 'failed'],
      [{ kind: 'agent_crashed', exitCode: 1 }, 'failed'],
      [{ kind: 'start_failed' }, 'failed'],
    ];
    for (const [cause, expected] of cases)
      for (const watched of ['completed', 'interrupted', 'failed', undefined] as const)
        should(endedStatus(cause, watched)).equal(expected);
  });

  it('should fall back to what this process watched for a record with no cause', () => {
    const watched: readonly (readonly [WatchedOutcome, EndedStatus])[] = [
      ['completed', 'completed'],
      ['interrupted', 'stopped'],
      ['failed', 'failed'],
    ];
    for (const [outcome, expected] of watched) should(endedStatus(undefined, outcome)).equal(expected);
  });

  it('should read `stopped` for a record with no cause that this process never watched', () => {
    should(endedStatus(undefined, undefined)).equal('stopped');
  });
});
