import { describe, expect, it } from 'bun:test';
import type { WardenLogin } from '@ferretry/protocol';
import {
  wardenAccountLabel,
  wardenAccountTitle,
  wardenAnomalyDigest,
  wardenExhaustionLabel,
  wardenInvestigationHead,
  wardenLoginProblem,
  wardenNeedsYouCount,
  wardenPacedUntil,
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
  it('names the login as its owner wrote it, never trimming a prefix off', () => {
    expect(wardenAccountLabel({ agent: 'claude-default' })).toBe('claude-default');
    expect(wardenAccountLabel({ agent: 'claude-auto-review' })).toBe('claude-auto-review');
    expect(wardenAccountLabel({ agent: 'codex-default' })).toBe('codex-default');
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
  const on = { configured: true, active: true, reason: 'configured' } as const;
  const off = { configured: false, active: false, reason: 'configured' } as const;

  it('should say a layer stopped only for this hour is paced, and until when', () => {
    // Arrange
    const base = wardenStatus();
    const paced = wardenStatus({
      triage: {
        jev: { configured: true, active: false, reason: 'jev_cap' },
        llm: { configured: true, active: false, reason: 'investigation_cap' },
      },
      spend: {
        ...base.spend,
        capsHit: ['jev', 'investigation'],
        capsPaced: ['jev'],
        pacedUntil: '2026-10-29T07:00:00.000Z',
      },
    });

    // Act / Assert
    expect(wardenTriageLabel(paced)).toBe('Rules only (Jev paced to 07:00, LLM cap hit)');
    expect(wardenPacedUntil(paced, 'jev')).toBe('07:00 UTC');
    expect(wardenPacedUntil(paced, 'investigation')).toBeUndefined();
  });

  it('should name the layers in effect, any the owner switched on that a cap stopped, or Off', () => {
    // Arrange
    const both = wardenStatus({ config: wardenConfig({ layers: { jev: true, llm: true } }) });
    const capped = wardenStatus({
      triage: { jev: { configured: true, active: false, reason: 'jev_cap' }, llm: on },
    });
    const investigationCapped = wardenStatus({
      triage: { jev: on, llm: { configured: true, active: false, reason: 'investigation_cap' } },
    });
    const rules = wardenStatus();
    const off_ = wardenStatus({ config: wardenConfig({ enabled: false }) });
    const disabled = wardenStatus({
      triage: {
        jev: { configured: true, active: false, reason: 'disabled' },
        llm: { configured: true, active: false, reason: 'disabled' },
      },
    });

    // Act
    const labels = [both, capped, investigationCapped, rules, off_, disabled].map(wardenTriageLabel);

    // Assert
    expect(labels).toEqual([
      'Rules + Jev + LLM',
      'Rules + LLM (Jev cap hit)',
      'Rules + Jev (LLM cap hit)',
      'Rules only',
      'Off',
      'Off',
    ]);
    expect(wardenTriageLabel(wardenStatus({ triage: { jev: off, llm: on } }))).toBe('Rules + LLM');
  });
});

describe('the investigation login', () => {
  it('should read the resolved head off the failover status, else the stored order', () => {
    // Arrange
    const resolved = wardenStatus({
      config: wardenConfig({ accounts: [] }),
      failover: wardenFailover({ accounts: [wardenAccount({ agent: 'claude-default' })] }),
    });
    const older = wardenStatus({ config: wardenConfig({ accounts: [{ agent: 'claude-spare' }] }) });

    // Act / Assert
    expect(wardenInvestigationHead(resolved)?.agent).toBe('claude-default');
    expect(wardenInvestigationHead(older)?.agent).toBe('claude-spare');
  });

  it('should say why no investigation can run, and nothing when one can', () => {
    // Arrange
    const known: WardenLogin = { source: 'configured', unknown: [], available: ['a'] };
    const lost: WardenLogin = { source: 'configured', unknown: ['legacy-wrapper'], available: ['a'] };

    // Act / Assert
    expect(wardenLoginProblem(undefined, [])).toBeNull();
    expect(wardenLoginProblem({ source: 'not_set', unknown: [], available: [] }, [])).toBe(
      'No investigation login is set',
    );
    expect(wardenLoginProblem(known, [{ agent: 'a' }])).toBeNull();
    expect(wardenLoginProblem(known, [])).toBeNull();
    expect(wardenLoginProblem(lost, [{ agent: 'legacy-wrapper' }, { agent: 'a' }])).toBeNull();
    expect(wardenLoginProblem(lost, [{ agent: 'legacy-wrapper' }])).toBe("Unknown login 'legacy-wrapper'");
  });

  it('should label investigations off for want of a login', () => {
    // Arrange
    const status = wardenStatus({
      triage: {
        jev: { configured: false, active: false, reason: 'configured' },
        llm: { configured: true, active: false, reason: 'no_login' },
      },
    });

    // Act / Assert
    expect(wardenTriageLabel(status)).toBe('Rules only (no login)');
  });
});
