import { expect, test } from 'bun:test';
import { AccountResolutionError } from '../../../../daemon/lib/moves/ports.ts';

test('an account resolution refusal carries the start vocabulary failure and its own message', () => {
  const error = new AccountResolutionError('unknown_agent', 'no account is published as "ghost"');
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('AccountResolutionError');
  expect(error.failure).toBe('unknown_agent');
  expect(error.message).toBe('no account is published as "ghost"');
});
