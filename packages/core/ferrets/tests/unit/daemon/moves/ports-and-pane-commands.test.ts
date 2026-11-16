import { expect, test } from 'bun:test';
import { capturePaneArguments } from '../../../../daemon/lib/moves/pane-commands.ts';
import { AccountResolutionError } from '../../../../daemon/lib/moves/ports.ts';

test('an account resolution refusal carries the start vocabulary failure and its own message', () => {
  const error = new AccountResolutionError('unknown_agent', 'no account is published as "ghost"');
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('AccountResolutionError');
  expect(error.failure).toBe('unknown_agent');
  expect(error.message).toBe('no account is published as "ghost"');
});

test('capturing a pane prints its visible rows, or the whole scrollback when history is asked for', () => {
  expect(capturePaneArguments('fy-wren', false)).toEqual(['capture-pane', '-p', '-t', 'fy-wren']);
  expect(capturePaneArguments('fy-wren', true)).toEqual(['capture-pane', '-p', '-S', '-', '-t', 'fy-wren']);
});
