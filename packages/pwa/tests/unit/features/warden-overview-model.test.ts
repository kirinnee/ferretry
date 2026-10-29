import { describe, expect, it } from 'bun:test';
import type { WardenStatusView } from '@ferretry/protocol';
import {
  accountChip,
  actionChip,
  actionRows,
  agoLabel,
  cooldownChip,
  durationLabel,
  canInvestigate,
  investigationRows,
  investigatorLabel,
  needsYouEmpty,
  needsYouRows,
  nextSweepLabel,
  percent,
  queuePosition,
  RECENT_ACTIONS_SHOWN,
  usd,
  verdictChip,
  wardenHowItWorks,
  wardenSavingsLine,
  wardenStatusLine,
  watchingRows,
} from '../../../src/features/warden/warden-overview-model.ts';
import { chip } from '../../../src/features/warden/warden-vocabulary.ts';
import {
  attentionItem,
  wardenAccount,
  wardenAction,
  wardenAnomaly,
  wardenAttention,
  wardenConfig,
  wardenInvestigation,
  wardenStatus,
} from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

/** An investigation the wire carries no target session for. */
const untargeted = (overrides: Parameters<typeof wardenInvestigation>[0]) => {
  const { targetSession: _target, ...rest } = wardenInvestigation(overrides);
  return rest;
};

const on = { configured: true, active: true, reason: 'configured' } as const;
const off = { configured: false, active: false, reason: 'configured' } as const;
const stopped = (reason: 'disabled' | 'jev_cap' | 'investigation_cap' | 'no_login') =>
  ({ configured: true, active: false, reason }) as const;

/** Both layers on: Jev in front of an investigation. */
const jevStatus = (overrides: Partial<WardenStatusView> = {}): WardenStatusView =>
  wardenStatus({
    config: wardenConfig({ layers: { jev: true, llm: true } }),
    triage: { jev: on, llm: on },
    ...overrides,
  });

/** Jev alone: what it does not clear is shown to the owner. */
const jevOnlyStatus = (overrides: Partial<WardenStatusView> = {}): WardenStatusView =>
  wardenStatus({
    config: wardenConfig({ layers: { jev: true, llm: false } }),
    triage: { jev: on, llm: off },
    ...overrides,
  });

const llmStatus = (overrides: Partial<WardenStatusView> = {}): WardenStatusView =>
  wardenStatus({
    config: wardenConfig({ layers: { jev: false, llm: true } }),
    triage: { jev: off, llm: on },
    ...overrides,
  });

describe('vocabulary helpers', () => {
  it('should format money, confidence and verdict chips', () => {
    // Arrange / Act / Assert
    expect(usd(0.4)).toBe('$0.40');
    expect(percent(0.956)).toBe('96%');
    expect(verdictChip('killed')).toEqual({ label: 'stop', tone: 'err' });
    expect(chip('running', 'accent', true)).toEqual({ label: 'running', tone: 'accent', busy: true });
  });

  it('should name each action outcome as a chip', () => {
    // Arrange
    const held = wardenAction({ action: 'stop', outcome: 'held' });
    const failed = wardenAction({ action: 'failover', outcome: 'failed' });
    const jevBless = wardenAction({ action: 'bless', by: 'jev', confidence: 0.96 });
    const jevBlessNoConfidence = wardenAction({ action: 'bless', by: 'jev' });
    const wardenBless = wardenAction({ action: 'bless', by: 'warden' });
    const ownerBless = wardenAction({ action: 'bless', by: 'owner' });
    const resumed = wardenAction({ action: 'resume' });

    // Act
    const chips = [held, failed, jevBless, jevBlessNoConfidence, wardenBless, ownerBless, resumed].map(actionChip);

    // Assert
    expect(chips).toEqual([
      { label: 'stop · asks you', tone: 'warn' },
      { label: 'fail over failed', tone: 'err' },
      { label: 'blessed by Jev 96%', tone: 'ok' },
      { label: 'blessed by Jev', tone: 'ok' },
      { label: 'blessed', tone: 'ok' },
      { label: 'left alone by you', tone: 'accent' },
      { label: 'revived', tone: 'ok' },
    ]);
  });
});

describe('a Jev action', () => {
  it('should read as Jev’s with its confidence, apart from an investigation’s', () => {
    // Arrange
    const jevNudge = wardenAction({ action: 'nudge', by: 'jev', confidence: 0.94 });
    const verdictNudge = wardenAction({ action: 'nudge', by: 'warden' });

    // Act / Assert
    expect(actionChip(jevNudge)).toEqual({ label: 'nudged', tone: 'accent' });
    expect(actionRows(wardenStatus({ actions: [jevNudge] }))[0]?.chips).toEqual([
      { label: 'nudged', tone: 'accent' },
      { label: 'Jev · 94% sure', tone: 'accent' },
    ]);
    expect(actionRows(wardenStatus({ actions: [verdictNudge] }))[0]?.chips).toEqual([
      { label: 'nudged', tone: 'accent' },
    ]);
  });

  it('should read “Jev recommends …” when it is held for the owner', () => {
    // Arrange
    const held = wardenAction({ action: 'stop', outcome: 'held', by: 'jev', confidence: 0.99 });
    const heldVerdict = wardenAction({ action: 'stop', outcome: 'held', by: 'warden' });

    // Act / Assert
    expect(actionChip(held)).toEqual({ label: 'Jev recommends stop · asks you', tone: 'warn' });
    expect(actionChip(heldVerdict)).toEqual({ label: 'stop · asks you', tone: 'warn' });
    expect(actionRows(wardenStatus({ actions: [held] }))[0]?.chips).toContainEqual({
      label: 'Jev · 99% sure',
      tone: 'accent',
    });
  });

  it('should name Jev without a number when no confidence was recorded, and keep a bless in its own chip', () => {
    // Arrange
    const bare = wardenAction({ action: 'restart', by: 'jev' });
    const bless = wardenAction({ action: 'bless', by: 'jev', confidence: 0.96 });

    // Act / Assert
    expect(actionRows(wardenStatus({ actions: [bare] }))[0]?.chips.map(entry => entry.label)).toEqual([
      'restarted',
      'Jev',
    ]);
    expect(actionRows(wardenStatus({ actions: [bless] }))[0]?.chips.map(entry => entry.label)).toEqual([
      'blessed by Jev 96%',
    ]);
  });

  it('should show Jev’s reason on a quieter line when it gave one, and nothing when it did not', () => {
    // Arrange
    const reasoned = wardenAction({
      action: 'resume',
      by: 'jev',
      confidence: 0.95,
      reason: 'The turn died with no error and the pane is idle.',
    });
    const plain = wardenAction({ action: 'resume', by: 'jev', confidence: 0.95 });

    // Act
    const [withReason] = actionRows(wardenStatus({ actions: [reasoned] }));
    const [without] = actionRows(wardenStatus({ actions: [plain] }));

    // Assert
    expect(withReason?.detail).toBe('Jev’s reason: The turn died with no error and the pane is idle.');
    expect(without?.detail).toBeUndefined();
  });
});

describe('time labels', () => {
  it('should say how long ago, or nothing for an unreadable instant', () => {
    // Arrange / Act / Assert
    expect(agoLabel(undefined, NOW)).toBeUndefined();
    expect(agoLabel('not a time', NOW)).toBeUndefined();
    expect(agoLabel(ago(0), NOW)).toBe('just now');
    expect(agoLabel(ago(-5), NOW)).toBe('just now');
    expect(agoLabel(ago(4), NOW)).toBe('4 min ago');
    expect(agoLabel(ago(180), NOW)).toBe('3 h ago');
    expect(agoLabel(ago(48 * 60), NOW)).toBe('2 d ago');
  });

  it('should say when the next sweep is due', () => {
    // Arrange / Act / Assert
    expect(nextSweepLabel(undefined, NOW)).toBeUndefined();
    expect(nextSweepLabel(ago(1), NOW)).toBe('next sweep due now');
    expect(nextSweepLabel(ago(-1.5), NOW)).toBe('next in 2 min');
  });

  it('should say a quiet stretch in minutes, hours, or both', () => {
    // Arrange / Act / Assert
    expect(durationLabel(45 * 60_000)).toBe('45 min');
    expect(durationLabel(0)).toBe('1 min');
    expect(durationLabel(120 * 60_000)).toBe('2 h');
    expect(durationLabel(80 * 60_000)).toBe('1 h 20 min');
  });
});

describe('wardenStatusLine', () => {
  it('should say the Warden is off and nothing else', () => {
    // Arrange
    const disabledLayers = wardenStatus({ triage: { jev: stopped('disabled'), llm: stopped('disabled') } });
    const offStatus = wardenStatus({ config: wardenConfig({ enabled: false }) });

    // Act / Assert
    expect(wardenStatusLine(offStatus, NOW)).toEqual({ lead: 'The Warden is off.', parts: ['Nothing is watched.'] });
    expect(wardenStatusLine(disabledLayers, NOW).lead).toBe('The Warden is off.');
  });

  it('should leave spend and investigations out of a rules-only line', () => {
    // Arrange
    const status = wardenStatus({ lastSweepAt: ago(1), nextSweepAt: ago(-1) });

    // Act
    const line = wardenStatusLine(status, NOW);

    // Assert
    expect(line).toEqual({ lead: 'Rules only', parts: ['every 2 min', 'swept 1 min ago', 'next in 1 min'] });
  });

  it('should give the Jev threshold, the investigator, and spend against both caps', () => {
    // Arrange
    const status = jevStatus({
      config: wardenConfig({
        layers: { jev: true, llm: true },
        accounts: [{ agent: 'claude-default', model: 'claude-sonnet-5-5' }],
      }),
      spend: { ...wardenStatus().spend, jevUsd: 0.02, investigationUsd: 0.4, jevCapUsd: 0.5, investigationCapUsd: 2 },
    });

    // Act
    const line = wardenStatusLine(status, NOW);

    // Assert
    expect(line).toEqual({
      lead: 'Rules + Jev + LLM',
      parts: [
        'Jev clears at ≥0.85',
        'claude-sonnet-5-5 investigations',
        'every 2 min',
        '$0.42 of $2.50 today',
        'not swept yet',
      ],
    });
  });

  it('should count only the cap of each layer that is on', () => {
    // Arrange
    const spend = { ...wardenStatus().spend, jevCapUsd: 0.5, investigationCapUsd: 2 };

    // Act
    const llm = wardenStatusLine(llmStatus({ spend }), NOW);
    const jev = wardenStatusLine(jevOnlyStatus({ spend }), NOW);

    // Assert
    expect(llm.lead).toBe('Rules + LLM');
    expect(llm.parts).toContain('claude-default investigations');
    expect(llm.parts).toContain('$0.00 of $2.00 today');
    expect(jev.lead).toBe('Rules + Jev');
    expect(jev.parts).not.toContain('claude-default investigations');
    expect(jev.parts).toContain('$0.00 of $0.50 today');
  });

  it('should say out loud every layer a cap, a key or a failure turned aside', () => {
    // Arrange
    const statuses = [
      jevStatus({ triage: { jev: on, llm: stopped('investigation_cap') } }),
      jevStatus({ triage: { jev: stopped('jev_cap'), llm: on } }),
      jevOnlyStatus({ triage: { jev: stopped('jev_cap'), llm: off } }),
      jevStatus({ triage: { jev: on, llm: on, guardFailure: { code: 'not_set', at: ago(1) } } }),
      jevOnlyStatus({ triage: { jev: on, llm: off, guardFailure: { code: 'not_set', at: ago(1) } } }),
      jevStatus({ triage: { jev: on, llm: on, guardBackoffUntil: ago(-3) } }),
      jevStatus({ triage: { jev: on, llm: on, guardBackoffUntil: ago(3) } }),
      jevOnlyStatus({ triage: { jev: on, llm: off, guardFailure: { code: 'rate_limited', at: ago(1) } } }),
      llmStatus({ triage: { jev: off, llm: on, guardFailure: { code: 'not_set', at: ago(1) } } }),
    ];

    // Act
    const warnings = statuses.map(status => wardenStatusLine(status, NOW).warning);

    // Assert
    expect(warnings).toEqual([
      'LLM cap hit — flags wait for you until midnight UTC',
      'Jev cap hit — every flag goes to an investigation until midnight UTC',
      'Jev cap hit — every flag waits for you until midnight UTC',
      'No Jev key — every flag goes to an investigation',
      'No Jev key — every flag waits for you',
      'Jev is busy — each flag goes to an investigation',
      undefined,
      'Jev failed (rate limited) — that flag waits for you',
      undefined,
    ]);
  });

  it('should say a cap reached only for this hour is back at the top of the hour, not at midnight', () => {
    // Arrange
    const base = jevStatus();
    const paced = (cap: 'jev' | 'investigation') => ({
      ...base.spend,
      capsHit: [cap],
      capsPaced: [cap],
      pacedUntil: '2026-10-29T07:00:00.000Z',
    });
    const statuses = [
      jevStatus({ triage: { jev: on, llm: stopped('investigation_cap') }, spend: paced('investigation') }),
      jevStatus({ triage: { jev: stopped('jev_cap'), llm: on }, spend: paced('jev') }),
    ];

    // Act
    const warnings = statuses.map(status => wardenStatusLine(status, NOW).warning);

    // Assert
    expect(warnings).toEqual([
      'This hour’s share of the LLM cap is spent — flags wait until 07:00 UTC',
      'This hour’s share of the Jev cap is spent — every flag goes to an investigation until 07:00 UTC',
    ]);
  });

  it('should name the investigator by login when no model is pinned', () => {
    // Arrange
    const status = wardenStatus({ config: wardenConfig({ accounts: [{ agent: 'codex-default' }] }) });
    const empty = { config: { ...wardenConfig(), accounts: [] } };

    // Act / Assert
    expect(investigatorLabel(status)).toBe('codex-default');
    expect(investigatorLabel(empty)).toBe('no login');
  });

  it('should say investigations are off for want of a login, and where to choose one', () => {
    // Arrange
    const triage = { jev: off, llm: stopped('no_login') };
    const unset = llmStatus({ triage, login: { source: 'not_set', unknown: [], available: [] } });
    const older = llmStatus({ triage });

    // Act / Assert
    expect(wardenStatusLine(unset, NOW).warning).toBe(
      'No investigation login is set — investigations are off until you choose one in Settings › Warden',
    );
    expect(wardenStatusLine(older, NOW).warning).toBe(
      'No investigation login — investigations are off until you choose one in Settings › Warden',
    );
  });
});

describe('wardenSavingsLine', () => {
  it('should say nothing while the Warden is off', () => {
    // Arrange
    const offStatus = wardenStatus({ config: wardenConfig({ enabled: false }) });
    const disabled = wardenStatus({ triage: { jev: stopped('disabled'), llm: stopped('disabled') } });

    // Act / Assert
    expect(wardenSavingsLine(offStatus)).toBeUndefined();
    expect(wardenSavingsLine(disabled)).toBeUndefined();
  });

  it('should say rules only spends nothing', () => {
    // Arrange
    const one = wardenStatus({ savings: { ...wardenStatus().savings, flags: 1 } });
    const many = wardenStatus({ savings: { ...wardenStatus().savings, flags: 7 } });

    // Act / Assert
    expect(wardenSavingsLine(one)).toBe('Today: 1 flag shown to you · no AI · $0.00');
    expect(wardenSavingsLine(many)).toBe('Today: 7 flags shown to you · no AI · $0.00');
  });

  it('should count LLM investigations and any still being priced', () => {
    // Arrange
    const status = llmStatus({
      spend: { ...wardenStatus().spend, investigationUsd: 1.2, pendingInvestigations: 2 },
      savings: { ...wardenStatus().savings, flags: 5, investigations: 5 },
    });

    // Act / Assert
    expect(wardenSavingsLine(status)).toBe('Today: 5 flags · 5 investigated ($1.20) · 2 pending');
  });

  it('should count what Jev cleared and say the rest went to the owner, with investigations off', () => {
    // Arrange
    const status = jevOnlyStatus({
      spend: { ...wardenStatus().spend, jevUsd: 0.02 },
      savings: { ...wardenStatus().savings, flags: 9, jevSkips: 7 },
    });

    // Act / Assert
    expect(wardenSavingsLine(status)).toBe('Today: 9 flags · 7 cleared by Jev ($0.02) · the rest shown to you');
  });

  it('should say how many flags Jev settled itself, when the daemon counted them', () => {
    // Arrange
    const spend = { ...wardenStatus().spend, jevUsd: 0.03, investigationUsd: 1.2 };
    const savings = { ...wardenStatus().savings, flags: 41, jevSkips: 30, investigations: 4, jevActions: 7 };

    // Act / Assert
    expect(wardenSavingsLine(jevStatus({ spend, savings }))).toBe(
      'Today: 41 flags · 30 cleared by Jev ($0.03) · Jev handled 7 itself · 4 investigated ($1.20)',
    );
    expect(wardenSavingsLine(jevOnlyStatus({ spend, savings }))).toBe(
      'Today: 41 flags · 30 cleared by Jev ($0.03) · Jev handled 7 itself · the rest shown to you',
    );
  });

  it('should give the Jev saving only when the daemon priced it', () => {
    // Arrange
    const spend = { ...wardenStatus().spend, jevUsd: 0.03, investigationUsd: 1.2 };
    const savings = { ...wardenStatus().savings, flags: 41, jevSkips: 37, investigations: 4 };
    const priced = jevStatus({ spend, savings: { ...savings, savedUsd: 11 } });
    const unpriced = jevStatus({ spend, savings });

    // Act / Assert
    expect(wardenSavingsLine(priced)).toBe(
      'Today: 41 flags · 37 cleared by Jev ($0.03) · 4 investigated ($1.20) · ~$11.00 saved vs investigating all',
    );
    expect(wardenSavingsLine(unpriced)).toBe('Today: 41 flags · 37 cleared by Jev ($0.03) · 4 investigated ($1.20)');
  });
});

describe('wardenHowItWorks', () => {
  it('should explain each mix of layers, crediting Jev only with clearing', () => {
    // Arrange / Act / Assert
    expect(wardenHowItWorks({ jev: false, llm: false })).toContain('No AI runs and nothing is spent.');
    expect(wardenHowItWorks({ jev: false, llm: true })).not.toContain('Jev');
    expect(wardenHowItWorks({ jev: false, llm: true })).toContain('Stopping asks you unless you allowed it');
    expect(wardenHowItWorks({ jev: true, llm: true })).toContain('does a simple fix itself when it is very sure');
    expect(wardenHowItWorks({ jev: true, llm: true })).toContain('anything else goes on');
    expect(wardenHowItWorks({ jev: true, llm: false })).toContain('anything else is shown to you');
    expect(wardenHowItWorks({ jev: true, llm: false })).toContain('No investigation runs.');
  });
});

describe('needsYouEmpty', () => {
  it('should only call a clean sweep an all-clear', () => {
    // Arrange / Act / Assert
    expect(needsYouEmpty('clean-sweep', false)).toBe('Nothing is waiting on you right now.');
    expect(needsYouEmpty('clean-sweep', true)).toContain('Not an all-clear');
    expect(needsYouEmpty('degraded', false)).toContain('not an all-clear');
    expect(needsYouEmpty('no-sweep', false)).toBe('No sweep has run yet, so nobody has been checked.');
  });
});

describe('needsYouRows', () => {
  it('should give one row per session, oldest wait first, gathering every chip', () => {
    // Arrange
    const view = wardenAttention({
      outcome: 'items',
      items: [
        attentionItem({ sessionId: 'b', id: 'b1', waitingSince: ago(5), source: 'task', subject: '', why: 'Blocked' }),
        attentionItem({
          sessionId: 'a',
          id: 'a1',
          teammate: 'marin',
          label: 'Flaky test',
          source: 'question',
          waitingSince: ago(40),
          judgement: {
            state: 'judged',
            verdict: 'needs_human',
            reason: 'Only you can choose.',
            judgedBy: { agent: 'claude-default', model: 'sonnet' },
          },
        }),
        attentionItem({
          sessionId: 'a',
          id: 'a2',
          source: 'warden-anomaly',
          anomalyKind: 'sus_thinking',
          waitingSince: ago(10),
          judgement: { state: 'judged', verdict: 'killed', reason: 'Loops.', reportPath: 'r/a.md' },
        }),
        attentionItem({ sessionId: 'c', id: 'c1', waitingSince: 'never', subject: 'Same', why: 'Same' }),
      ],
    });

    // Act
    const rows = needsYouRows(view);

    // Assert
    expect(rows.map(row => row.sessionId)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toEqual({
      key: 'needs:a',
      sessionId: 'a',
      teammate: 'marin',
      label: 'Flaky test',
      reason: 'Which relay? — Waiting for your answer.',
      detail: 'Judged by claude-default · sonnet',
      chips: [
        { label: 'question', tone: 'warn' },
        { label: 'long think', tone: 'warn' },
        { label: 'Warden: needs you', tone: 'warn' },
        { label: 'Warden: stop', tone: 'err' },
        { label: '+1 more reason', tone: 'pend' },
      ],
      at: ago(40),
      leave: true,
      reportPath: 'r/a.md',
    });
    expect(rows[1]).toMatchObject({ reason: 'Blocked', chips: [{ label: 'task', tone: 'pend' }] });
    expect(rows[1]).not.toHaveProperty('leave');
    expect(rows[2]?.reason).toBe('Same');
  });

  it('should leave flags being judged to Watching and offer Investigate only on unjudged flags', () => {
    // Arrange
    const view = wardenAttention({
      items: [
        attentionItem({ sessionId: 'pending', judgement: { state: 'pending', reason: 'checking' } }),
        attentionItem({ sessionId: 'queued', judgement: { state: 'queued', reason: 'queued' } }),
        attentionItem({ sessionId: 'unjudged', source: 'warden-anomaly' }),
        attentionItem({
          sessionId: 'failed',
          source: 'warden-anomaly',
          anomalyKind: 'dead_monitor',
          judgement: { state: 'failed', reason: 'timed out' },
        }),
        attentionItem({
          sessionId: 'none',
          source: 'warden-action',
          judgement: { state: 'none', reason: 'nothing matched' },
        }),
        attentionItem({ sessionId: 'raised', source: 'agent-raised', subject: '', why: '' }),
        attentionItem({
          sessionId: 'judged-no-who',
          judgement: { state: 'judged', verdict: 'unknown', reason: 'r', judgedBy: {} },
        }),
        attentionItem({ sessionId: 'judged-no-verdict', judgement: { state: 'judged', reason: 'r' } }),
      ],
    });

    // Act
    const rows = needsYouRows(view);

    // Assert
    expect(rows.map(row => row.sessionId)).not.toContain('pending');
    expect(rows.map(row => row.sessionId)).not.toContain('queued');
    const by = new Map(rows.map(row => [row.sessionId, row]));
    expect(by.get('unjudged')).toMatchObject({ investigate: true, chips: [{ label: 'flagged', tone: 'warn' }] });
    expect(by.get('failed')).toMatchObject({
      investigate: true,
      chips: [
        { label: 'pane lost', tone: 'err' },
        { label: 'Warden failed', tone: 'err' },
      ],
    });
    expect(by.get('none')).toMatchObject({ chips: [{ label: 'asks you', tone: 'warn' }] });
    expect(by.get('none')?.investigate).toBeUndefined();
    expect(by.get('raised')).toMatchObject({ reason: 'No reason recorded.', chips: [{ label: 'asks for you' }] });
    expect(by.get('judged-no-who')?.detail).toBeUndefined();
    expect(by.get('judged-no-who')?.chips).toContainEqual({ label: 'Warden: reviewed', tone: 'pend' });
    expect(by.get('judged-no-verdict')?.chips).toEqual([{ label: 'question', tone: 'warn' }]);
  });

  it('should keep a judgement with no provenance quiet', () => {
    // Arrange
    const view = wardenAttention({
      items: [attentionItem({ judgement: { state: 'judged', verdict: 'cleared', reason: 'fine' } })],
    });

    // Act
    const [row] = needsYouRows(view);

    // Assert
    expect(row?.detail).toBeUndefined();
    expect(row?.chips).toContainEqual({ label: 'Warden: leave', tone: 'ok' });
  });

  it('should expose the unjudged-flag rule directly', () => {
    // Arrange / Act / Assert
    expect(canInvestigate(attentionItem({ source: 'warden-anomaly' }))).toBe(true);
    expect(canInvestigate(attentionItem({ source: 'question' }))).toBe(false);
    expect(
      canInvestigate(attentionItem({ source: 'warden-anomaly', judgement: { state: 'judged', reason: 'r' } })),
    ).toBe(false);
  });
});

describe('watchingRows', () => {
  it('should list current flags with their investigation state, never repeating a Needs-you session', () => {
    // Arrange
    const running = wardenInvestigation({ id: 'w-run', targetSession: 'marin', state: 'running' });
    const status = wardenStatus({
      anomalies: [
        wardenAnomaly({
          sessionId: 'marin',
          kind: 'sus_thinking',
          teammate: 'marin',
          label: 'Fix',
          since: ago(14),
          detail: 'Thinking',
        }),
        wardenAnomaly({ sessionId: 'marin', kind: 'sus_subprocess', detail: 'second' }),
        wardenAnomaly({ sessionId: 'jay', kind: 'dead_monitor', detail: 'Pane closed' }),
        wardenAnomaly({ sessionId: 'needs', detail: 'already in needs' }),
        wardenAnomaly({ sessionId: 'hadi', kind: 'quota_reset_passed', detail: 'Quota reset' }),
      ],
      investigations: [
        running,
        wardenInvestigation({ id: 'q2', targetSession: 'other', state: 'queued', queuedAt: ago(1) }),
        wardenInvestigation({ id: 'q1', targetSession: 'jay', state: 'queued', queuedAt: ago(5) }),
      ],
      blessings: [{ sessionId: 'hadi', kinds: ['sus_subprocess'], expiresAt: ago(-10), by: 'jev' }],
      actions: [wardenAction({ sessionId: 'hadi', action: 'bless', by: 'jev', confidence: 0.96 })],
    });

    // Act
    const rows = watchingRows(status, undefined, new Set(['needs']), NOW);

    // Assert
    expect(rows.map(row => row.sessionId)).toEqual(['marin', 'jay', 'hadi']);
    expect(rows[0]).toEqual({
      key: 'watch:marin',
      sessionId: 'marin',
      teammate: 'marin',
      label: 'Fix',
      reason: 'Thinking',
      chips: [
        { label: 'long think', tone: 'warn' },
        { label: 'long command', tone: 'pend' },
        { label: 'investigating', tone: 'accent', busy: true },
      ],
      at: ago(14),
      leave: true,
    });
    expect(rows[1]?.chips).toContainEqual({ label: 'queued #1', tone: 'pend' });
    expect(rows[2]?.chips).toContainEqual({ label: 'cleared · Jev 96%', tone: 'ok' });
    expect(rows[2]?.chips).toContainEqual({ label: 'quiet 10 min', tone: 'ok' });
  });

  it('should add flags being judged and sessions a blessing cleared', () => {
    // Arrange
    const status = wardenStatus({
      anomalies: [wardenAnomaly({ sessionId: 'flagged' })],
      blessings: [
        { sessionId: 'blessed', kinds: ['sus_subprocess', 'sus_thinking'], expiresAt: ago(-5), by: 'jev' },
        { sessionId: 'quiet', kinds: ['dead_monitor'], expiresAt: ago(-5), by: 'warden' },
        { sessionId: 'flagged', kinds: ['dead_monitor'], expiresAt: ago(-5), by: 'warden' },
        { sessionId: 'needs', kinds: ['dead_monitor'], expiresAt: ago(-5), by: 'warden' },
      ],
      actions: [
        wardenAction({ sessionId: 'blessed', action: 'bless', by: 'jev', at: ago(3), detail: 'Healthy build.' }),
        wardenAction({ sessionId: 'quiet', action: 'bless', by: 'warden' }),
      ],
    });
    const attention = wardenAttention({
      items: [
        attentionItem({
          sessionId: 'checking',
          teammate: 'kofi',
          label: 'Design',
          judgement: { state: 'pending', reason: 'r' },
        }),
        attentionItem({ sessionId: 'waiting', judgement: { state: 'queued', reason: 'r' } }),
        attentionItem({ sessionId: 'flagged', judgement: { state: 'queued', reason: 'r' } }),
        attentionItem({ sessionId: 'needs', judgement: { state: 'queued', reason: 'r' } }),
        attentionItem({ sessionId: 'settled' }),
      ],
    });

    // Act
    const rows = watchingRows(status, attention, new Set(['needs']), NOW);

    // Assert
    const by = new Map(rows.map(row => [row.sessionId, row]));
    expect([...by.keys()]).toEqual(['flagged', 'checking', 'waiting', 'blessed', 'quiet']);
    expect(by.get('flagged')?.chips).toContainEqual({ label: 'cleared', tone: 'ok' });
    expect(by.get('checking')).toMatchObject({
      teammate: 'kofi',
      label: 'Design',
      chips: [{ label: 'question' }, { label: 'investigating', busy: true }],
    });
    expect(by.get('waiting')?.chips).toContainEqual({ label: 'queued', tone: 'pend' });
    expect(by.get('blessed')).toEqual({
      key: 'watch:blessed',
      sessionId: 'blessed',
      reason: 'Healthy build.',
      chips: [
        { label: 'long command', tone: 'pend' },
        { label: 'long think', tone: 'warn' },
        { label: 'cleared', tone: 'ok' },
        { label: 'quiet 5 min', tone: 'ok' },
      ],
      at: ago(3),
      leave: true,
    });
    expect(by.get('quiet')?.chips).toContainEqual({ label: 'cleared', tone: 'ok' });
  });

  it('should explain a blessing whose action is no longer listed', () => {
    // Arrange
    const status = wardenStatus({
      blessings: [{ sessionId: 'old', kinds: ['dead_monitor'], expiresAt: ago(-5), by: 'jev' }],
    });

    // Act
    const [row] = watchingRows(status, undefined, new Set(), NOW);

    // Assert
    expect(row?.reason).toBe('Judged healthy, so these flags are not raised again for a while.');
    expect(row?.at).toBeUndefined();
  });
});

describe('investigationRows', () => {
  it('should put running first, then the queue in order, then finished ones', () => {
    // Arrange
    const first = wardenInvestigation({ id: 'q-first', state: 'queued', queuedAt: ago(9), targetSession: 'x' });
    const status = wardenStatus({
      investigations: [
        wardenInvestigation({
          id: 'done',
          state: 'done',
          verdict: 'cleared',
          origin: 'jev',
          anomalyKind: 'sus_thinking',
          finishedAt: ago(2),
          reportPath: 'r/done.md',
          agent: 'claude-default',
          model: 'sonnet',
          costUsd: 0.31,
        }),
        untargeted({ id: 'q-second', state: 'queued', queuedAt: ago(1), origin: 'owner', wardenSession: 'ws' }),
        wardenInvestigation({ id: 'run', state: 'running', startedAt: ago(3) }),
        first,
        untargeted({ id: 'fleet', state: 'done', scope: 'fleet' }),
        wardenInvestigation({ id: 'fleet-kind', state: 'done', scope: 'fleet', anomalyKind: 'dead_monitor' }),
      ],
    });

    // Act
    const rows = investigationRows(status);

    // Assert
    expect(rows.map(row => row.key)).toEqual([
      'investigation:run',
      'investigation:q-second',
      'investigation:q-first',
      'investigation:done',
      'investigation:fleet',
      'investigation:fleet-kind',
    ]);
    expect(rows[0]).toMatchObject({
      reason: 'Flagged by the sweep',
      chips: [{ label: 'investigating', busy: true }],
      at: ago(3),
    });
    expect(rows[1]).toMatchObject({
      sessionId: 'ws',
      reason: 'You asked for an investigation',
      chips: [{ label: 'queued #2' }],
    });
    expect(rows[2]?.chips).toEqual([{ label: 'queued #1', tone: 'pend' }]);
    expect(rows[3]).toEqual({
      key: 'investigation:done',
      sessionId: 'sess-1',
      reason: 'Jev sent it for a closer look: long think',
      detail: 'claude-default · sonnet · $0.31',
      chips: [{ label: 'leave', tone: 'ok' }],
      at: ago(2),
      reportPath: 'r/done.md',
      verdict: 'cleared',
    });
    expect(rows[4]).toMatchObject({
      sessionId: 'fleet',
      reason: 'Fleet triage of several flags',
      chips: [{ label: 'done' }],
    });
    expect(rows[4]?.detail).toBeUndefined();
    expect(rows[5]?.reason).toBe('Fleet triage of several flags: pane lost');
    expect(queuePosition(status, first)).toBe(1);
  });
});

describe('actionRows', () => {
  it('should list recent actions with their anomaly and failover target, capped', () => {
    // Arrange
    const actions = [
      wardenAction({
        action: 'failover',
        agent: 'claude-spare',
        anomalyKind: 'quota_reset_passed',
        reportPath: 'r.md',
      }),
      wardenAction({ action: 'failover' }),
      ...Array.from({ length: RECENT_ACTIONS_SHOWN + 3 }, () => wardenAction()),
    ];
    const status = wardenStatus({ actions });

    // Act
    const rows = actionRows(status);

    // Assert
    expect(rows).toHaveLength(RECENT_ACTIONS_SHOWN);
    expect(rows[0]).toEqual({
      key: `action:${actions[0]?.at}:sess-1:0`,
      sessionId: 'sess-1',
      reason: 'Asked it to report its blocker.',
      chips: [
        { label: 'failed over', tone: 'accent' },
        { label: 'quota reset', tone: 'pend' },
        { label: '→ claude-spare', tone: 'pend' },
      ],
      at: actions[0]?.at,
      reportPath: 'r.md',
    });
    expect(rows[1]?.chips).toEqual([{ label: 'failed over', tone: 'accent' }]);
  });
});

describe('accountChip', () => {
  it('should mark the login in use and say why one cannot be used', () => {
    // Arrange / Act / Assert
    expect(accountChip(wardenAccount(), 'claude-default')).toEqual({ label: 'claude-default · in use', tone: 'ok' });
    expect(accountChip(wardenAccount({ agent: 'claude-spare' }), 'claude-default')).toEqual({
      label: 'claude-spare',
      tone: 'ok',
    });
    expect(
      accountChip(wardenAccount({ agent: 'codex-default', eligible: false, reason: 'at limit' }), undefined),
    ).toEqual({
      label: 'codex-default · at limit',
      tone: 'warn',
    });
    expect(accountChip(wardenAccount({ eligible: false }), undefined)).toEqual({
      label: 'claude-default · unavailable',
      tone: 'warn',
    });
  });
});

describe('cooldownChip', () => {
  it('should say how long a cleared ferret stays quiet, and how many clears in a row made it so', () => {
    // Arrange
    const blessing = { sessionId: 's', kinds: ['dead_monitor' as const], expiresAt: ago(-90), by: 'jev' as const };

    // Act / Assert
    expect(cooldownChip(blessing, NOW)).toEqual({ label: 'quiet 1 h 30 min', tone: 'ok' });
    expect(cooldownChip({ ...blessing, streak: 2 }, NOW)).toEqual({ label: 'quiet 1 h 30 min · ×3', tone: 'ok' });
    expect(cooldownChip({ ...blessing, untilChange: true }, NOW)).toEqual({
      label: 'quiet until it changes',
      tone: 'ok',
    });
  });

  it('should credit the owner for a ferret they left alone', () => {
    // Arrange
    const status = wardenStatus({
      blessings: [{ sessionId: 'mine', kinds: ['dead_monitor'], expiresAt: ago(-60), by: 'owner', untilChange: true }],
      actions: [wardenAction({ sessionId: 'mine', action: 'bless', by: 'owner', detail: 'You left it.' })],
    });

    // Act
    const [row] = watchingRows(status, undefined, new Set(), NOW);

    // Assert
    expect(row?.chips).toEqual([
      { label: 'pane lost', tone: 'err' },
      { label: 'left alone by you', tone: 'accent' },
      { label: 'quiet until it changes', tone: 'ok' },
    ]);
  });
});
