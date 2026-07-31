import { describe, expect, it } from 'bun:test';
import {
  displayCallsign,
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyCountLabel,
  wardenAnomalyDigest,
  wardenExhaustionLabel,
} from '../../../src/features/warden/warden-status-model.ts';
import { wardenAccount, wardenAnomaly, wardenFailover } from '../../support/warden.ts';

describe('displayCallsign', () => {
  it('title-cases every hyphen-separated segment', () => {
    expect(displayCallsign('ms-98-uuot')).toBe('Ms-98-Uuot');
  });

  it('answers with an empty string rather than a placeholder when there is no callsign', () => {
    expect(displayCallsign(undefined)).toBe('');
    expect(displayCallsign('   ')).toBe('');
  });

  it('survives a slug with empty segments', () => {
    expect(displayCallsign('a--b')).toBe('A--B');
  });
});

describe('wardenExhaustionLabel', () => {
  it('says nothing at all while failover is healthy', () => {
    expect(wardenExhaustionLabel(undefined)).toBeUndefined();
    expect(wardenExhaustionLabel(wardenFailover())).toBeUndefined();
  });

  it('distinguishes an auth failure from a quota failure, because the fixes differ', () => {
    const exhaustedSince = '2026-07-31T00:00:00.000Z';
    const authFailed = wardenFailover({
      exhaustedSince,
      accounts: [wardenAccount({ eligible: false, quota: { authOk: false } })],
    });
    const quotaFailed = wardenFailover({
      exhaustedSince,
      accounts: [wardenAccount({ eligible: false, reason: 'weekly limit reached' })],
    });

    expect(wardenExhaustionLabel(authFailed)).toBe('no warden credentials!');
    expect(wardenExhaustionLabel(quotaFailed)).toBe('no usable warden account!');
  });

  it('reads a stated credentials reason as an auth failure', () => {
    const failover = wardenFailover({
      exhaustedSince: '2026-07-31T00:00:00.000Z',
      accounts: [wardenAccount({ eligible: false, reason: 'credentials rejected by the provider' })],
    });

    expect(wardenExhaustionLabel(failover)).toBe('no warden credentials!');
  });

  it('needs EVERY account to be an auth failure before blaming credentials', () => {
    const failover = wardenFailover({
      exhaustedSince: '2026-07-31T00:00:00.000Z',
      accounts: [
        wardenAccount({ agent: 'a', eligible: false, quota: { authOk: false } }),
        wardenAccount({ agent: 'b', eligible: false, reason: 'at limit' }),
      ],
    });

    expect(wardenExhaustionLabel(failover)).toBe('no usable warden account!');
  });

  it('does not claim a credentials failure when there are no accounts to judge', () => {
    const failover = wardenFailover({ exhaustedSince: '2026-07-31T00:00:00.000Z', accounts: [] });

    expect(wardenExhaustionLabel(failover)).toBe('no usable warden account!');
  });
});

describe('wardenAccountLabel and wardenAccountTitle', () => {
  it('strips the wrapper prefix that every chip would otherwise repeat', () => {
    expect(wardenAccountLabel({ agent: 'claude-auto-loge' })).toBe('loge');
    expect(wardenAccountLabel({ agent: 'codex-auto-terra' })).toBe('terra');
    expect(wardenAccountLabel({ agent: 'gemini-sol' })).toBe('gemini-sol');
  });

  it('uses the daemon’s own stated reason and never invents one', () => {
    expect(wardenAccountTitle({ eligible: true })).toBe('healthy');
    expect(wardenAccountTitle({ eligible: false, reason: 'demoted' })).toBe('demoted');
    expect(wardenAccountTitle({ eligible: false })).toBe('ineligible');
  });
});

describe('wardenAnomalyDigest', () => {
  it('reads clean with nothing to say when there are no anomalies', () => {
    expect(wardenAnomalyDigest([])).toEqual({ count: 0, clean: true, summary: '', detail: '' });
  });

  it('names each anomaly by callsign, falling back to the session id', () => {
    const digest = wardenAnomalyDigest([
      wardenAnomaly({ teammate: 'ms-98', sessionId: 'sess-1' }),
      wardenAnomaly({ kind: 'sus_thinking', sessionId: 'sess-2' }),
    ]);

    expect(digest.detail).toBe('dead_monitor: Ms-98\nsus_thinking: sess-2');
  });

  it('caps the glance at three kinds and counts the rest', () => {
    const digest = wardenAnomalyDigest([
      wardenAnomaly({ kind: 'dead_monitor' }),
      wardenAnomaly({ kind: 'sus_thinking' }),
      wardenAnomaly({ kind: 'sus_subprocess' }),
      wardenAnomaly({ kind: 'quota_reset_passed' }),
      wardenAnomaly({ kind: 'bootstrap_degraded' }),
    ]);

    expect(digest.summary).toBe('dead_monitor, sus_thinking, sus_subprocess +2');
    expect(digest.count).toBe(5);
    expect(digest.clean).toBe(false);
  });

  it('adds no overflow marker at exactly three', () => {
    const digest = wardenAnomalyDigest([wardenAnomaly(), wardenAnomaly(), wardenAnomaly()]);

    expect(digest.summary).toBe('dead_monitor, dead_monitor, dead_monitor');
  });
});

describe('wardenAnomalyCountLabel', () => {
  it('pluralises the count and states cleanliness positively', () => {
    expect(wardenAnomalyCountLabel(0)).toBe('no anomalies');
    expect(wardenAnomalyCountLabel(1)).toBe('1 anomaly');
    expect(wardenAnomalyCountLabel(4)).toBe('4 anomalies');
  });
});
