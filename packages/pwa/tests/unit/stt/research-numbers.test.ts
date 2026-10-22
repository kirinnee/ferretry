/**
 * Proves every engine card carries the research benchmark's numbers, said the same way: word error
 * rates for everyday and technical speech with the key terms caught, and the wait after Stop with the
 * memory used.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { ON_DEVICE_MODELS } from '../../../src/lib/stt/model-catalog.ts';
import { RESEARCH } from '../../../src/lib/stt/research-numbers.ts';

describe('the research numbers', () => {
  it('are on every on-device engine, from the one benchmark', () => {
    for (const model of ON_DEVICE_MODELS) {
      should(Object.values(RESEARCH)).containEql(model.measured);
      should(model.measured?.where).startWith('research benchmark');
      should(model.measured?.accuracy).match(/WER on everyday speech; .* on technical speech, \d+ of 33 key terms$/u);
      should(model.measured?.speed).match(/from Stop to text; .* of memory$/u);
    }
  });

  it('say the Zipformer is weak on technical terms and Parakeet 110M quick on a phone', () => {
    should(RESEARCH.zipformerEn.accuracy).containEql('17 of 33 key terms');
    should(RESEARCH.parakeetTdt110m.speed).startWith('1.7 s from Stop to text');
  });
});
