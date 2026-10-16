import { describe, expect, it } from 'bun:test';
import {
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyDigest,
  wardenExhaustionLabel,
  wardenNeedsYouCount,
  wardenTriageLabel,
} from '../../../src/features/warden/warden-status-model.ts';
import {
  wardenAccount,
  wardenAction,
  wardenAnomaly,
  wardenConfig,
  wardenFailover,
  wardenInvestigation,
  wardenStatus,
} from '../../support/warden.ts';

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

  it('should name each anomaly by a plain chip and callsign, falling back to the session id', () => {
    // Arrange
    const anomalies = [
      wardenAnomaly({ teammate: 'ms-98', sessionId: 'sess-1' }),
      wardenAnomaly({ kind: 'sus_thinking', sessionId: 'sess-2' }),
    ];

    // Act
    const digest = wardenAnomalyDigest(anomalies);

    // Assert
    expect(digest.detail).toBe('pane lost: Ms-98\nlong think: sess-2');
  });

  it('should cap the glance at three distinct chips and count the rest', () => {
    // Arrange
    const anomalies = [
      wardenAnomaly({ kind: 'dead_monitor' }),
      wardenAnomaly({ kind: 'sus_thinking' }),
      wardenAnomaly({ kind: 'sus_subprocess' }),
      wardenAnomaly({ kind: 'quota_reset_passed' }),
      wardenAnomaly({ kind: 'bootstrap_degraded' }),
    ];

    // Act
    const digest = wardenAnomalyDigest(anomalies);

    // Assert
    expect(digest.summary).toBe('pane lost, long think, long command +2');
    expect(digest.count).toBe(5);
    expect(digest.clean).toBe(false);
  });

  it('should say a repeated kind once and add no overflow marker', () => {
    // Arrange
    const anomalies = [wardenAnomaly(), wardenAnomaly(), wardenAnomaly()];

    // Act
    const digest = wardenAnomalyDigest(anomalies);

    // Assert
    expect(digest.summary).toBe('pane lost');
    expect(digest.count).toBe(3);
  });
});

describe('wardenNeedsYouCount', () => {
  it('should count held actions and flags nothing investigates or cleared, once per session', () => {
    // Arrange
    const status = wardenStatus({
      anomalies: [
        wardenAnomaly({ sessionId: 'flagged' }),
        wardenAnomaly({ sessionId: 'investigated' }),
        wardenAnomaly({ sessionId: 'blessed' }),
        wardenAnomaly({ sessionId: 'held' }),
      ],
      investigations: [
        wardenInvestigation({ targetSession: 'investigated', state: 'queued' }),
        wardenInvestigation({ id: 'w2', targetSession: 'flagged', state: 'done' }),
      ],
      blessings: [{ sessionId: 'blessed', kinds: ['dead_monitor'], expiresAt: '2026-07-31T13:00:00.000Z', by: 'jev' }],
      actions: [
        wardenAction({ sessionId: 'held', action: 'stop', outcome: 'held' }),
        wardenAction({ sessionId: 'done', outcome: 'done' }),
      ],
    });

    // Act
    const count = wardenNeedsYouCount(status);

    // Assert
    expect(count).toBe(2);
  });
});

describe('wardenTriageLabel', () => {
  it('should name the triage in effect, a cap fallback, or Off', () => {
    // Arrange
    const jev = wardenStatus({ config: wardenConfig({ triage: 'jev' }) });
    const capped = wardenStatus({
      triage: { configured: 'jev', effective: 'rules', reason: 'jev_cap' },
    });
    const investigationCapped = wardenStatus({
      triage: { configured: 'llm', effective: 'rules', reason: 'investigation_cap' },
    });
    const off = wardenStatus({ config: wardenConfig({ enabled: false }) });
    const disabled = wardenStatus({ triage: { configured: 'rules', effective: 'rules', reason: 'disabled' } });

    // Act
    const labels = [jev, capped, investigationCapped, off, disabled].map(wardenTriageLabel);

    // Assert
    expect(labels).toEqual(['Jev guard', 'Rules only (cap hit)', 'Rules only (cap hit)', 'Off', 'Off']);
  });
});
