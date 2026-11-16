import { describe, expect, test } from 'bun:test';
import { type LedgerRecord, sendFailureNotice } from '@ferretry/core-mailbox/contract';

/**
 * What a sender is told when a send it made could not be proven: one sentence per way the proof went missing, each
 * saying whether sending it again is safe. The Mailbox's own tests pin the wording; these run it from the tracker's side.
 */
const record = (over: Partial<LedgerRecord>): LedgerRecord =>
  ({ sendId: 's1', fate: 'unaccounted', ...over }) as LedgerRecord;

describe('the notice for a send that could not be proven', () => {
  test('a send typed with no transcript to prove it says it most likely arrived, and to restart the recipient’s CLI', () => {
    expect(sendFailureNotice('hadi', record({ unaccountedReason: 'transcript_unbound' }), 'fy')).toMatch(
      /Do not send it again — it most likely arrived.*restart hadi’s CLI/su,
    );
  });

  test('a send a revive handed over as the first turn says it most likely landed', () => {
    expect(sendFailureNotice('hadi', record({ unaccountedReason: 'revive_unconfirmed' }), 'fy')).toMatch(
      /first turn of its relaunch.*do not send it again unless hadi stays silent/su,
    );
  });

  test('an unconfirmed send may have landed twice over; a send never delivered names its attempts', () => {
    expect(sendFailureNotice('hadi', record({ unaccountedReason: 'transcript_unreadable' }), 'fy')).toMatch(
      /may still have landed.*twice.*`fy send hadi …`/su,
    );
    expect(sendFailureNotice('hadi', record({ fate: 'timed_out', attempt: 3 }), 'fy')).toMatch(
      /not delivered \(not delivered\) after 3 attempt\(s\)/u,
    );
    expect(sendFailureNotice('hadi', record({ fate: 'timed_out', unaccountedReason: 'ferret_ended' }), 'fy')).toMatch(
      /\(ferret ended\) after 1 attempt\(s\)/u,
    );
  });
});
