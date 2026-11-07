import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

test('Updates is no longer pending (FY_UPDATE_CHECK=off is honoured); Tidy remains pending while its owned surfaces are incomplete', () => {
  expect(ports.pending).not.toContain('updates');
  expect(ports.pending).toContain('tidy');
});
