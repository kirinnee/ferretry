import { describe, it } from 'bun:test';
import should from 'should';
import { readableReason } from '../../../../src/features/session-info/session-info.tsx';

describe('readableReason', () => {
  it('keeps a daemon sentence as it is', () => {
    should(readableReason('the daemon is offline')).equal('the daemon is offline');
  });

  it('replaces a raw parse dump with a sentence a person can read', () => {
    const plain = 'the daemon answered with something this page cannot read';
    should(readableReason('[ { "expected": "object", "path": ["results"] } ]')).equal(plain);
    should(readableReason('{"error":"x"}')).equal(plain);
    should(readableReason('x'.repeat(161))).equal(plain);
  });
});
