import { expect, test } from 'bun:test';
import ports from '../../../../../ports-pending.json' with { type: 'json' };

test('Updates and Tidy remain pending while their owned surfaces and kernel contracts are incomplete', () => {
  expect(ports.pending).toContain('updates');
  expect(ports.pending).toContain('tidy');
});
