import { describe, expect, it } from 'bun:test';
import { ACCOUNT_STATUS_SHAPES, AccountStatus } from '../../../../../src/features/fleet/shell/account-status.tsx';
import { mount } from '../../../../support/dom.ts';

describe('AccountStatus', () => {
  it('gives each of the four words its own shape', () => {
    expect(Object.values(ACCOUNT_STATUS_SHAPES).map(shape => `${shape.glyph} ${shape.label}`)).toEqual([
      '● Ready',
      '◐ Refresh due',
      '○ Needs sign-in',
      '◌ Checking',
    ]);
  });

  it('always says the word: spoken by default, visible when asked, and overridable', async () => {
    const view = await mount(
      <div>
        <AccountStatus word="refresh_due" />
        <AccountStatus word="ready" label="Online" showLabel className="extra" />
      </div>,
    );
    const [hidden, shown] = Array.from(view.container.querySelectorAll('[data-status-shape]'));
    expect(hidden?.textContent).toBe('◐Refresh due');
    expect(hidden?.querySelector('.sr-only')?.textContent).toBe('Refresh due');
    expect(shown?.getAttribute('data-status-shape')).toBe('ready');
    expect(shown?.className).toContain('extra');
    expect(shown?.querySelector('.sr-only')).toBeNull();
    expect(shown?.textContent).toBe('●Online');
    await view.unmount();
  });
});
