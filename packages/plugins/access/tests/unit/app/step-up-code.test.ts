/** The app kit spells Gate's step-up wire code itself (it cannot import Gate); this pins the two equal. */
import { STEP_UP_REFUSAL_CODE } from '@ferretry/app/ui';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { expect, test } from 'bun:test';

test('the app kit’s step-up refusal code is Gate’s', () => {
  expect(STEP_UP_REFUSAL_CODE).toBe(STEP_UP_REQUIRED_CODE);
});
