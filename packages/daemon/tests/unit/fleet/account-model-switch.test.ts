import { describe, it } from 'bun:test';
import should from 'should';
import {
  ACCOUNT_MODEL_DISABLED_SENTENCE,
  accountModelWritesRefusal,
} from '../../../src/lib/fleet/account-model-switch.ts';

describe('accountModelWritesRefusal', () => {
  it('should refuse with the one sentence while the switch is off', () => {
    // Act + Assert
    should(accountModelWritesRefusal({ accountModel: { enabled: false } })).equal(ACCOUNT_MODEL_DISABLED_SENTENCE);
    should(ACCOUNT_MODEL_DISABLED_SENTENCE).equal('The new account model is not switched on for this machine yet.');
  });

  it('should allow a write once the operator switched it on', () => {
    // Act + Assert
    should(accountModelWritesRefusal({ accountModel: { enabled: true } })).be.undefined();
  });
});
