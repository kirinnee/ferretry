import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

test('Updates is no longer pending (FY_UPDATE_CHECK=off is honoured)', () => {
  expect(ports.pending).not.toContain('updates');
});
