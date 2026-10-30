import { describe, expect, it } from 'bun:test';
import type { WardenStatusView } from '@ferretry/protocol';
import type { WardenReadState } from '../../../src/hooks/use-warden-poll.ts';
import {
  accountChip,
  agoLabel,
  compactAgo,
  cooldownChip,
  durationLabel,
  fullTime,
  investigationRows,
  investigatorLabel,
  nextSweepLabel,
  percent,
  queuePosition,
  usd,
  verdictChip,
  wardenHowItWorks,
  wardenInboxLine,
  wardenStatusLine,
  watchingRows,
} from '../../../src/features/warden/warden-overview-model.ts';
import { chip } from '../../../src/features/warden/warden-vocabulary.ts';
import {
  agendaItem,
  wardenAccount,
  wardenAction,
  wardenAnomaly,
  wardenAgenda,
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
      'Jev paused: daily cap reached — every flag goes to an investigation until midnight UTC',
      'Jev paused: daily cap reached — every flag waits for you until midnight UTC',
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
      jevOnlyStatus({ triage: { jev: stopped('jev_cap'), llm: off }, spend: paced('jev') }),
    ];

    // Act
    const warnings = statuses.map(status => wardenStatusLine(status, NOW).warning);

    // Assert
    expect(warnings).toEqual([
      'Full checks paused until 07:00 UTC — new flags wait for you',
      'Jev paused until 07:00 UTC — new flags go to a full check',
      'Jev paused until 07:00 UTC — new flags wait for you',
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

describe('watchingRows', () => {
  it('should list current flags with their investigation state', () => {
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
    const rows = watchingRows(status, undefined, NOW);

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
      ],
      actions: [
        wardenAction({ sessionId: 'blessed', action: 'bless', by: 'jev', at: ago(3), detail: 'Healthy build.' }),
        wardenAction({ sessionId: 'quiet', action: 'bless', by: 'warden' }),
      ],
    });
    const agenda = wardenAgenda({
      items: [
        agendaItem({
          sessionId: 'checking',
          teammate: 'kofi',
          label: 'Design',
          judgement: { state: 'pending', reason: 'r' },
        }),
        agendaItem({ sessionId: 'waiting', judgement: { state: 'queued', reason: 'r' } }),
        agendaItem({ sessionId: 'flagged', judgement: { state: 'queued', reason: 'r' } }),
        agendaItem({ sessionId: 'settled' }),
      ],
    });

    // Act
    const rows = watchingRows(status, agenda, NOW);

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

  it('should chip an older daemon’s flag being judged by its kind, or as flagged when it names none', () => {
    // Arrange
    const status = wardenStatus();
    const agenda = wardenAgenda({
      outcome: 'items',
      items: [
        agendaItem({
          sessionId: 'kind',
          source: 'warden-anomaly',
          anomalyKind: 'sus_thinking',
          judgement: { state: 'pending', reason: 'r' },
        }),
        agendaItem({ sessionId: 'bare', source: 'warden-anomaly', judgement: { state: 'queued', reason: 'r' } }),
      ],
    });

    // Act
    const by = new Map(watchingRows(status, agenda, NOW).map(row => [row.sessionId, row]));

    // Assert
    expect(by.get('kind')?.chips[0]).toEqual({ label: 'long think', tone: 'warn' });
    expect(by.get('bare')?.chips[0]).toEqual({ label: 'flagged', tone: 'warn' });
  });

  it('should explain a blessing whose action is no longer listed', () => {
    // Arrange
    const status = wardenStatus({
      blessings: [{ sessionId: 'old', kinds: ['dead_monitor'], expiresAt: ago(-5), by: 'jev' }],
    });

    // Act
    const [row] = watchingRows(status, undefined, NOW);

    // Assert
    expect(row?.reason).toBe('Judged healthy, so these flags are not raised again for a while.');
    expect(row?.at).toBeUndefined();
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
    const [row] = watchingRows(status, undefined, NOW);

    // Assert
    expect(row?.chips).toEqual([
      { label: 'pane lost', tone: 'err' },
      { label: 'left alone by you', tone: 'accent' },
      { label: 'quiet until it changes', tone: 'ok' },
    ]);
  });
});

describe('compactAgo and fullTime', () => {
  it('should give the narrow time column and the full instant for its tooltip', () => {
    // Arrange / Act / Assert
    expect(compactAgo(ago(0), NOW)).toBe('now');
    expect(compactAgo(ago(-3), NOW)).toBe('now');
    expect(compactAgo(ago(5), NOW)).toBe('5m');
    expect(compactAgo(ago(17 * 60), NOW)).toBe('17h');
    expect(compactAgo(ago(48 * 60), NOW)).toBe('2d');
    expect(fullTime('2026-07-31T09:14:59.000Z')).toBe('2026-07-31 09:14 UTC');
  });

  it('should return nothing for an unreadable instant and the text itself for a full time', () => {
    // Arrange / Act / Assert
    expect(compactAgo(undefined, NOW)).toBe('');
    expect(compactAgo('not a time', NOW)).toBe('');
    expect(fullTime('not a time')).toBe('not a time');
  });
});

describe('wardenInboxLine', () => {
  const ready = (view: ReturnType<typeof wardenAgenda>): WardenReadState<ReturnType<typeof wardenAgenda>> => ({
    status: 'ready',
    view,
  });

  it('should show nothing while the read is loading', () => {
    // Arrange / Act / Assert
    expect(wardenInboxLine({ status: 'loading' })).toEqual({ kind: 'hidden' });
  });

  it('should count the notifications and link to the Inbox', () => {
    // Arrange
    const one = ready(wardenAgenda({ items: [agendaItem()] }));
    const two = ready(wardenAgenda({ items: [agendaItem(), agendaItem({ id: 'item-2' })] }));

    // Act / Assert
    expect(wardenInboxLine(one)).toEqual({ kind: 'link', text: '1 Warden notification in Inbox', stale: false });
    expect(wardenInboxLine(two)).toEqual({ kind: 'link', text: '2 Warden notifications in Inbox', stale: false });
  });

  it('should say none only after a clean read of an empty inbox', () => {
    // Arrange / Act / Assert
    expect(wardenInboxLine(ready(wardenAgenda()))).toEqual({ kind: 'none', text: 'No Warden notifications' });
  });

  it('should mark a count taken from an older read as stale', () => {
    // Arrange
    const stale: WardenReadState<ReturnType<typeof wardenAgenda>> = {
      status: 'stale',
      view: wardenAgenda({ items: [agendaItem()] }),
      reason: 'offline',
    };

    // Act / Assert
    expect(wardenInboxLine(stale)).toMatchObject({ kind: 'link', stale: true });
  });

  it('should warn, never all-clear, over a failed, degraded, stale-empty or unswept read', () => {
    // Arrange
    const warning = { kind: 'warning' as const, text: 'Couldn’t count Warden notifications' };
    const failed: WardenReadState<ReturnType<typeof wardenAgenda>> = { status: 'error', reason: 'offline' };
    const degraded = ready(wardenAgenda({ outcome: 'degraded' }));
    const noSweep = ready(wardenAgenda({ outcome: 'no-sweep' }));
    const staleEmpty: WardenReadState<ReturnType<typeof wardenAgenda>> = {
      status: 'stale',
      view: wardenAgenda(),
      reason: 'offline',
    };

    // Act / Assert
    expect(wardenInboxLine(failed)).toEqual(warning);
    expect(wardenInboxLine(degraded)).toEqual(warning);
    expect(wardenInboxLine(noSweep)).toEqual(warning);
    expect(wardenInboxLine(staleEmpty)).toEqual(warning);
  });
});

describe('investigationRows', () => {
  it('should put running first, then the queue in order, then finished ones', () => {
    // Arrange
    const first = wardenInvestigation({ id: 'q-first', state: 'queued', queuedAt: ago(9), targetSession: 'x' });
    const status = wardenStatus({
      investigations: [
        wardenInvestigation({ id: 'done', state: 'done', verdict: 'cleared', finishedAt: ago(2) }),
        wardenInvestigation({ id: 'q-second', state: 'queued', queuedAt: ago(1) }),
        wardenInvestigation({ id: 'run', state: 'running', startedAt: ago(3) }),
        first,
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
    ]);
    expect(rows[0]?.chip).toEqual({ label: 'investigating', tone: 'accent', busy: true });
    expect(rows[1]?.chip).toEqual({ label: 'queued #2', tone: 'pend' });
    expect(rows[2]?.chip).toEqual({ label: 'queued #1', tone: 'pend' });
    expect(queuePosition(status, first)).toBe(1);
  });

  it('should name the investigator with the system callsign display and fall back without a name', () => {
    // Arrange
    const status = wardenStatus({
      investigations: [
        wardenInvestigation({ id: 'named', state: 'done', wardenName: 'warden-00002a' }),
        untargeted({ id: 'fleet', state: 'done', scope: 'fleet' }),
        wardenInvestigation({ id: 'plain', state: 'done' }),
      ],
    });

    // Act
    const rows = investigationRows(status);

    // Assert
    expect(rows[0]).toMatchObject({ investigator: 'warden-00002A', named: true, sessionId: 'sess-1' });
    expect(rows[1]).toMatchObject({ investigator: 'Fleet triage', named: false });
    expect(rows[1]?.sessionId).toBeUndefined();
    expect(rows[2]).toMatchObject({ investigator: 'Investigation', named: false });
  });

  it('should name a fleet triage by its investigator and say a queued one has not started', () => {
    // Arrange
    const status = wardenStatus({
      investigations: [
        untargeted({ id: 'fleet', state: 'done', scope: 'fleet', wardenName: 'warden-00002c' }),
        wardenInvestigation({ id: 'queued:sess-1', state: 'queued', queuedAt: ago(1) }),
      ],
    });

    // Act
    const rows = investigationRows(status);

    // Assert
    expect(rows.find(row => row.key === 'investigation:fleet')).toMatchObject({
      investigator: 'warden-00002C · Fleet triage',
      named: true,
    });
    expect(rows.find(row => row.key === 'investigation:queued:sess-1')).toMatchObject({
      investigator: 'Not started',
      named: false,
    });
  });

  it('should carry the verdict, report, anomaly, cost and the time it finished', () => {
    // Arrange
    const status = wardenStatus({
      investigations: [
        wardenInvestigation({
          id: 'done',
          state: 'done',
          origin: 'jev',
          verdict: 'killed',
          anomalyKind: 'sus_thinking',
          finishedAt: ago(2),
          startedAt: ago(5),
          reportPath: 'r/done.md',
          agent: 'claude-default',
          model: 'sonnet',
          costUsd: 0.31,
        }),
      ],
    });

    // Act
    const [row] = investigationRows(status);

    // Assert
    expect(row).toEqual({
      key: 'investigation:done',
      sessionId: 'sess-1',
      investigator: 'Investigation',
      named: false,
      chip: { label: 'stop', tone: 'err' },
      anomaly: { label: 'long think', tone: 'warn' },
      cost: '$0.31',
      at: ago(2),
      title: 'Jev sent it for a closer look · claude-default · sonnet',
      reportPath: 'r/done.md',
      verdict: 'killed',
      jev: 'Jev: no record — from before Jev’s results were kept',
    });
  });
});
