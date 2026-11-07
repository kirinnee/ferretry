import { describe, expect, it } from 'bun:test';
import { GRANT_REFUSALS, grantRefusalCode } from '@ferretry/core-gate/contract';
import { DaemonCallError } from '@ferretry/app';
import { GRANT_EXPLANATIONS, grantRefusalNotice } from '../../../app/lib/grant-notice.ts';

describe('what a grant refusal says', () => {
  it('has a sentence for every reason Gate declares, and no other', () => {
    expect(Object.keys(GRANT_EXPLANATIONS).sort()).toEqual([...GRANT_REFUSALS].sort());
  });

  it('reads each reason from the code Gate’s routes answer with', () => {
    for (const reason of GRANT_REFUSALS) {
      const notice = grantRefusalNotice(new DaemonCallError(403, grantRefusalCode(reason), 'daemon sentence'));
      expect(notice).toEqual({ refusal: reason, detail: 'daemon sentence', explanation: GRANT_EXPLANATIONS[reason] });
    }
  });

  it('answers 503 for a daemon that cannot read its grant document, and nothing for any other failure', () => {
    expect(grantRefusalNotice(new DaemonCallError(503, 'grants_undetermined', ''))?.refusal).toBe('undetermined');
    expect(grantRefusalNotice(new DaemonCallError(404, 'grant_not_granted', ''))).toBeNull();
    expect(grantRefusalNotice(new DaemonCallError(403, 'forbidden', ''))).toBeNull();
    expect(grantRefusalNotice(new Error('network'))).toBeNull();
    expect(grantRefusalNotice(null)).toBeNull();
  });
});
