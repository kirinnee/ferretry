import { describe, expect, it } from 'bun:test';
import type { ProviderQuotaReading } from '@ferretry/protocol';
import {
  ACCOUNT_STATUS_SHAPES,
  AccountStatus,
  ProviderQuota,
  providerWindowAmount,
  providerWindowText,
} from '../../../../../src/features/fleet/shell/account-status.tsx';
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

const NOW = Date.parse('2026-10-16T09:00:00.000Z');
const reading = (overrides: Partial<ProviderQuotaReading> = {}): ProviderQuotaReading => ({
  source: 'openrouter-key',
  via: 'endpoint',
  windows: [],
  exhausted: false,
  unverified: false,
  at: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

describe('ProviderQuota (docs/provider-quotas.md)', () => {
  it('draws a bar only for a window with a share used, and says each amount the provider gave', async () => {
    const view = await mount(
      <ProviderQuota
        now={NOW}
        reading={reading({
          windows: [
            {
              label: '5h',
              usedPercent: 80,
              resetsAt: '2026-10-16T11:00:00.000Z',
              unit: 'prompts',
              used: 1200,
              limit: 1500,
            },
            { label: 'key', unit: 'usd', used: 4.2, limit: 10, usedPercent: 42 },
            { label: 'month', unit: 'usd', used: 8.25 },
            { label: 'week' },
          ],
          balance: { amount: 5.8, currency: 'USD' },
          note: 'Read a minute ago.',
        })}
      />,
    );
    const root = view.container;
    expect(root.querySelector('[data-provider-quota]')?.getAttribute('data-provider-quota')).toBe('endpoint');
    expect(root.querySelectorAll('[role="img"]')).toHaveLength(2);
    expect(root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '5 h: 80% used · 1200 of 1500 prompts · resets in 2h',
    );
    expect(root.querySelector('[data-provider-quota-window="key"]')?.textContent).toContain(
      '42% used · $4.20 of $10.00',
    );
    expect(root.querySelector('[data-provider-quota-window="month"]')?.textContent).toBe('Month$8.25');
    expect(root.querySelector('[data-provider-quota-window="week"]')?.textContent).toBe('Weeknot measured');
    expect(root.querySelector('[data-provider-quota-balance]')?.textContent).toBe('Balance: $5.80');
    expect(root.textContent).toContain('Read a minute ago.');
    expect(root.textContent).not.toContain('Usage unknown');
    await view.unmount();
  });

  it('says what this machine’s sessions cost when that is all there is, and when it is a floor', async () => {
    const view = await mount(
      <ProviderQuota
        now={NOW}
        reading={reading({
          source: 'transcript-pricing',
          via: 'transcript',
          spend: { amountUsd: 3.1, since: '2026-10-01T00:00:00.000Z', sessions: 4, unpriced: 1 },
        })}
      />,
    );
    expect(view.container.querySelector('[data-provider-quota-spend]')?.textContent).toBe(
      'This month, from this machine’s sessions: $3.10 (1 unpriced, so at least this)',
    );
    await view.unmount();
  });

  it('says "usage unknown" with the reason, an exhausted login, and an undocumented source', async () => {
    const unknown = await mount(
      <ProviderQuota now={NOW} reading={reading({ via: 'unknown', note: 'The provider refused this key.' })} />,
    );
    expect(unknown.container.querySelector('[data-credential-usage="unknown"]')?.textContent).toBe(
      'Usage unknown — The provider refused this key.',
    );
    await unknown.unmount();

    const bare = await mount(<ProviderQuota now={NOW} reading={reading({ via: 'unknown' })} />);
    expect(bare.container.textContent).toBe('Usage unknown');
    await bare.unmount();

    const spent = await mount(
      <ProviderQuota
        now={NOW}
        reading={reading({ exhausted: true, unverified: true, windows: [{ label: '5h', usedPercent: 100 }] })}
      />,
    );
    expect(spent.container.textContent).toContain('At its limit');
    expect(spent.container.textContent).toContain('a source it does not document');
    await spent.unmount();
  });

  it('writes amounts plainly', () => {
    expect(providerWindowAmount({ label: 'tools', unit: 'requests', used: 120.456 })).toBe('120.46 requests');
    expect(providerWindowAmount({ label: 'tools' })).toBeNull();
    expect(providerWindowText({ label: 'week' }, NOW)).toBe('');
  });
});
