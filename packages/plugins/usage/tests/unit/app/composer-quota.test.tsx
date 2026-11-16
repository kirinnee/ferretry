import { describe, expect, test } from 'bun:test';
import { render } from '@ferretry/app/testing';
import type { ReactTestInstance } from 'react-test-renderer';
import { ComposerQuota, composerQuotaPercent, composerQuotaSpoken } from '../../../app/shell/composer-quota.tsx';

const findText = (node: ReactTestInstance, text: string): ReactTestInstance[] =>
  node.findAll(candidate => candidate.children.includes(text));

describe('the composer quota', () => {
  test('renders the composer quota as a daemon-supplied context token, never a dash', () => {
    expect(composerQuotaPercent(-3)).toBe('0%');
    expect(composerQuotaPercent(12.6)).toBe('13%');
    expect(composerQuotaPercent(140)).toBe('100%');
    expect(composerQuotaSpoken(null)).toBe('Account usage unknown: the daemon has no reading for this account yet.');
    expect(composerQuotaSpoken({ weeklyPercent: 40 })).toBe(
      'Account usage: 5-hour window unknown; weekly window 40% used.',
    );
    expect(composerQuotaSpoken({ fiveHourPercent: 12 })).toBe(
      'Account usage: 5-hour window 12% used; weekly window unknown.',
    );

    // Nothing known: said in words, with no window label and no dash.
    for (const quota of [undefined, null, {}, { fiveHourPercent: Number.NaN }]) {
      const unknown = render(<ComposerQuota quota={quota} />);
      const token = unknown.root.findByProps({ className: 'fy-composer-quota' });
      expect(token.props['data-quota']).toBe('unknown');
      expect(findText(token, 'usage unknown')).toHaveLength(1);
      expect(JSON.stringify(unknown.toJSON())).not.toContain('—');
      expect(JSON.stringify(unknown.toJSON())).not.toContain('5h');
    }
    const limited = render(<ComposerQuota quota={{ atLimit: true }} />);
    expect(findText(limited.root, 'at limit')).toHaveLength(1);
    expect(limited.root.findAllByProps({ className: 'fy-quota-error' })).toHaveLength(1);
    expect(composerQuotaSpoken({ atLimit: true })).toContain('Account is at limit');

    // A credit-billed login with no window says its money, in words and aloud.
    const credit = render(<ComposerQuota quota={{ balance: { amount: 12.5, currency: 'USD' } }} />);
    expect(credit.root.findByProps({ className: 'fy-composer-quota' }).props['data-quota']).toBe('known');
    expect(findText(credit.root, '$12.50 left')).toHaveLength(1);
    expect(composerQuotaSpoken({ spendUsd: 3 })).toBe('Account usage: $3.00 this month.');

    // One window known: only that one is drawn.
    const weekOnly = render(<ComposerQuota quota={{ weeklyPercent: 40 }} />);
    expect(findText(weekOnly.root, 'wk 40%')).toHaveLength(1);
    expect(JSON.stringify(weekOnly.toJSON())).not.toContain('5h');
    expect(weekOnly.root.findAllByProps({ className: 'fy-quota-divider' })).toHaveLength(0);

    const auth = render(<ComposerQuota quota={{ authOk: false }} />);
    expect(findText(auth.root, 'quota auth!')).toHaveLength(1);

    const warning = render(<ComposerQuota quota={{ fiveHourPercent: 75, weeklyPercent: 10 }} />);
    expect(warning.root.findAllByProps({ className: ' fy-quota-warning' })).toHaveLength(1);

    const both = render(<ComposerQuota quota={{ fiveHourPercent: 75, weeklyPercent: 92, atLimit: true }} />);
    const quota = both.root.findByProps({ className: 'fy-composer-quota' });
    expect(quota.props.title).toContain('Account is at limit');
    expect(quota.props['data-quota']).toBe('known');
    expect(findText(quota, '5h 75%')).toHaveLength(1);
    expect(findText(quota, 'wk 92%')).toHaveLength(1);
    expect(quota.findAllByProps({ className: 'fy-quota-divider' })).toHaveLength(1);
    expect(both.root.findAllByProps({ className: ' fy-quota-error' })).toHaveLength(2);
  });
});
