import { describe, it } from 'bun:test';
import should from 'should';
import { CaptureError, captureErrorFrom } from '../../../src/lib/stt/capture-error.ts';

describe('captureErrorFrom', () => {
  it('passes an already-classified failure straight through', () => {
    const original = new CaptureError('no-media-devices', 'no devices');
    should(captureErrorFrom(original)).equal(original);
  });

  it('classifies the refusals by the stable DOMException name', () => {
    should(captureErrorFrom({ name: 'NotAllowedError' }).code).equal('permission-denied');
    should(captureErrorFrom({ name: 'SecurityError' }).code).equal('permission-denied');
    should(captureErrorFrom({ name: 'NotFoundError' }).code).equal('no-microphone');
    should(captureErrorFrom({ name: 'OverconstrainedError' }).code).equal('no-microphone');
    should(captureErrorFrom({ name: 'NotReadableError' }).code).equal('audio-unavailable');
    should(captureErrorFrom({ name: 'AbortError' }).code).equal('audio-unavailable');
  });

  it('says something a reader can act on rather than repeating the browser', () => {
    should(captureErrorFrom({ name: 'NotAllowedError' }).message).equal('Microphone access was blocked for this site.');
  });

  it('keeps an unrecognised Error message, which is the only clue there is', () => {
    const failure = captureErrorFrom(new Error('device fell over'));
    should(failure.code).equal('capture-failed');
    should(failure.message).equal('device fell over');
    should(failure.name).equal('CaptureError');
  });

  it('has a message for a thrown non-Error', () => {
    should(captureErrorFrom('nope').message).equal('Recording could not start.');
    should(captureErrorFrom(null).code).equal('capture-failed');
  });
});
