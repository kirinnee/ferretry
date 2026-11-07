import { describe, it } from 'bun:test';
import should from 'should';
import {
  launchReasoningEffort,
  persistedFast,
  persistedReasoningEffort,
  reasoningLevel,
  SETTINGS_FILE,
} from '../../../daemon/lib/harness/launch-effort.ts';

/**
 * The level a brand-new ferret starts on, read before the harness has said anything about itself.
 *
 * What matters is what these REFUSE: a value that is prose rather than a level, and a malformed document are
 * both "no evidence", never an error.
 */

describe('persistedReasoningEffort', () => {
  it('should name the file Claude Code persists its level in', () => {
    should(SETTINGS_FILE).equal('settings.json');
  });

  it("should read Claude's effortLevel, normalised", () => {
    should(persistedReasoningEffort('{"effortLevel":" High ","model":"x"}')).equal('high');
  });

  it('should answer nothing for a document that names no usable level', () => {
    should(persistedReasoningEffort('{"model":"x"}')).be.undefined();
    should(persistedReasoningEffort('{"effortLevel":3}')).be.undefined();
    should(persistedReasoningEffort('{"effortLevel":"think very hard please"}')).be.undefined();
    should(persistedReasoningEffort('[]')).be.undefined();
    should(persistedReasoningEffort('null')).be.undefined();
    should(persistedReasoningEffort('{not json')).be.undefined();
    should(persistedReasoningEffort(undefined)).be.undefined();
  });
});

describe('reasoningLevel', () => {
  it('should accept a short word and refuse prose, digits and blanks', () => {
    should(['Max', ' x-high ', 'x_high', '9', 'two words', '', 5].map(reasoningLevel)).deepEqual([
      'max',
      'x-high',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('launchReasoningEffort', () => {
  it("should prefer the start request's level over the home's persisted one", () => {
    should(launchReasoningEffort('Max', 'high')).equal('max');
  });

  it('should fall back to the persisted level, then to none at all', () => {
    should(launchReasoningEffort(undefined, 'high')).equal('high');
    should(launchReasoningEffort('   ', 'medium')).equal('medium');
    should(launchReasoningEffort(undefined, undefined)).be.undefined();
  });
});

describe('persistedFast', () => {
  it('should read the saved fast mode, on or off', () => {
    should(persistedFast('{"fastMode":true}')).equal(true);
    should(persistedFast('{"fastMode":false,"effortLevel":"high"}')).equal(false);
  });

  it('should answer nothing when the document has not said', () => {
    should(persistedFast('{"fastMode":"yes"}')).be.undefined();
    should(persistedFast('{}')).be.undefined();
    should(persistedFast('[true]')).be.undefined();
    should(persistedFast('null')).be.undefined();
    should(persistedFast('{not json')).be.undefined();
    should(persistedFast(undefined)).be.undefined();
  });
});
