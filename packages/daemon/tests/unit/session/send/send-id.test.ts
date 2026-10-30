import { describe, it } from 'bun:test';
import should from 'should';
import { canonicalSendId, sameSendId } from '../../../../src/lib/session/send/send-id.ts';

describe('daemon-written send ids across the agenda rename', () => {
  it('should spell an attention- id the way this daemon writes it, and leave every other id alone', () => {
    should(canonicalSendId('attention-session-1-A1-abc')).equal('agenda-session-1-A1-abc');
    should(canonicalSendId('attention-nudge-session-1-3')).equal('agenda-nudge-session-1-3');
    should(canonicalSendId('agenda-session-1-A1-abc')).equal('agenda-session-1-A1-abc');
    should(canonicalSendId('send-1')).equal('send-1');
  });

  it('should treat the two spellings of one id as one send, and different ids as different', () => {
    should(sameSendId('attention-s-A1-x', 'agenda-s-A1-x')).be.true();
    should(sameSendId('agenda-s-A1-x', 'attention-s-A1-x')).be.true();
    should(sameSendId('agenda-s-A1-x', 'agenda-s-A1-x')).be.true();
    should(sameSendId('attention-s-A1-x', 'agenda-s-A1-y')).be.false();
  });
});
