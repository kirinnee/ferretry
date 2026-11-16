import { describe, expect, it } from 'bun:test';
import { initialModeOf } from '../../../../app/views/move.tsx';

describe('the switch the move page opens on', () => {
  it('is the CLI side only when the address names it, so the account side stays the default', () => {
    expect(initialModeOf('?mode=cli')).toBe('cli');
    expect(initialModeOf('')).toBe('account');
    expect(initialModeOf('?mode=account')).toBe('account');
    expect(initialModeOf('?mode=other')).toBe('account');
  });
});
