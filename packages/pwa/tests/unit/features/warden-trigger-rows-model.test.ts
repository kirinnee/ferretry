import { describe, expect, it } from 'bun:test';
import {
  displaySystemCallsign,
  type WardenJevBefore,
  type WardenJevCheck,
  type WardenStatusView,
} from '@ferretry/protocol';
import {
  filterTriggerRows,
  NO_FILTERS,
  pageTriggerRows,
  resultFilterOptions,
  TRIGGERS_PAGE,
  triggerRows,
  triggerTotal,
  WHO_FILTERS,
} from '../../../src/features/warden/warden-trigger-rows-model.ts';
import { wardenAction, wardenInvestigation, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const check = (overrides: Partial<WardenJevCheck> = {}): WardenJevCheck => ({
  at: at(60),
  sessionId: 'sess-1',
  anomalyKind: 'sus_thinking',
  verdict: 'handed_on',
  confidence: 0.4,
  costUsd: 0.0004,
  route: 'investigation',
  ...overrides,
});

const rowsOf = (overrides: Partial<WardenStatusView>) => triggerRows(wardenStatus(overrides), NOW);
const only = (overrides: Partial<WardenStatusView>) => {
  const rows = rowsOf(overrides);
  expect(rows).toHaveLength(1);
  return rows[0] as NonNullable<(typeof rows)[number]>;
};

describe('triggerRows: one row per trigger', () => {
  it('should join a Jev check, its investigation and its act into ONE row by the links the daemon wrote', () => {
    // Arrange
    const jev: WardenJevBefore = { verdict: 'handed_on', why: 'unsure', at: at(60), confidence: 0.4, costUsd: 0.0004 };
    const status = {
      jevChecks: [check({ at: at(60) })],
      investigations: [
        wardenInvestigation({
          state: 'done',
          startedAt: at(58),
          finishedAt: at(50),
          anomalyKind: 'sus_thinking',
          reportPath: 'r/1.md',
          wardenName: 'warden-0007',
          agent: 'claude-default',
          model: 'sonnet',
          verdict: 'nudged',
          jev,
        }),
      ],
      actions: [
        wardenAction({
          at: at(49),
          action: 'nudge',
          reportPath: 'r/1.md',
          investigator: 'warden-0007',
          anomalyKind: 'sus_thinking',
          jev,
        }),
      ],
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.who).toBe('jev_llm');
    expect(row.whoLabel).toBe('Jev → LLM');
    expect(row.runtime).toBe('claude-default · sonnet');
    expect(row.result).toMatchObject({ key: 'nudged', label: 'Nudged' });
    expect(row.flag.label).toBe('long think');
    expect(row.reportPath).toBe('r/1.md');
    expect(row.timeline.map(step => step.kind)).toEqual(['flag', 'jev', 'llm', 'act']);
    expect(row.timeline[1]?.cost).toBe('$0.0004');
    expect(row.timeline[2]?.reportPath).toBe('r/1.md');
    expect(row.times[0]?.compact).toBe('1h');
    expect(row.times[0]?.ago).toBe('1 h ago');
  });

  it('should join by the investigator alone, and by ferret + time window when no link was kept', () => {
    // Arrange
    const byName = {
      investigations: [
        wardenInvestigation({ state: 'done', startedAt: at(90), wardenName: 'warden-0007', verdict: 'killed' }),
      ],
      actions: [
        wardenAction({
          at: at(80),
          action: 'stop',
          reportPath: 'r/2.md',
          investigator: 'warden-0007',
          detail: 'Stopped.',
        }),
      ],
    };
    const byWindow = {
      jevChecks: [check({ at: at(100) })],
      investigations: [wardenInvestigation({ state: 'done', startedAt: at(95), anomalyKind: 'sus_thinking' })],
      actions: [wardenAction({ at: at(90), action: 'resume', reportPath: 'r/3.md' })],
    };

    // Act
    const named = only(byName);
    const windowed = only(byWindow);

    // Assert
    expect(named.who).toBe('llm');
    expect(named.result.key).toBe('stopped');
    expect(windowed.who).toBe('jev_llm');
    expect(windowed.result.key).toBe('resumed');
    expect(windowed.timeline.map(step => step.kind)).toEqual(['flag', 'jev', 'llm', 'act']);
  });

  it('should not join an act to an investigation that names a different report, or one outside the window', () => {
    // Arrange
    const status = {
      investigations: [
        wardenInvestigation({ state: 'done', startedAt: at(90), reportPath: 'r/a.md', verdict: 'cleared' }),
        wardenInvestigation({
          id: 'w2',
          state: 'done',
          queuedAt: at(500),
          targetSession: 'sess-2',
          verdict: 'cleared',
        }),
        wardenInvestigation({
          id: 'w3',
          state: 'done',
          finishedAt: at(30),
          targetSession: 'sess-3',
          verdict: 'cleared',
        }),
      ],
      actions: [
        wardenAction({ at: at(80), reportPath: 'r/b.md' }),
        wardenAction({ at: at(100), sessionId: 'sess-2', reportPath: 'r/c.md' }),
        wardenAction({ at: at(1), sessionId: 'sess-2', reportPath: 'r/d.md' }),
        wardenAction({ at: at(5), sessionId: 'other', reportPath: 'r/e.md' }),
      ],
    };

    // Act
    const rows = rowsOf(status);

    // Assert
    expect(rows).toHaveLength(7);
    expect(
      rows.find(row => row.sessionId === 'sess-1' && row.result.key === 'left' && row.reportPath === 'r/a.md'),
    ).toBeDefined();
  });

  it('should ignore fleet investigations and investigations with no ferret', () => {
    // Arrange
    const status = {
      investigations: [
        wardenInvestigation({ scope: 'fleet', startedAt: at(10) }),
        wardenInvestigation({ id: 'w2', startedAt: at(10) }),
      ],
    };
    const noTarget = rowsOf({
      investigations: [{ id: 'w3', state: 'running', scope: 'session', origin: 'sweep', startedAt: at(10) }],
    });

    // Act

    // Assert
    expect(rowsOf(status)).toHaveLength(1);
    expect(noTarget).toHaveLength(0);
  });

  it('should show a Jev check that went on to no investigation as its own Handed-to-LLM row', () => {
    // Arrange / Act
    const row = only({ jevChecks: [check()] });

    // Assert
    expect(row.who).toBe('jev');
    expect(row.result).toMatchObject({ key: 'handed', label: 'Handed to LLM' });
    expect(row.runtime).toBeUndefined();
    expect(row.reportPath).toBeUndefined();
    expect(row.jev).toBeUndefined();
  });

  it('should make Maryah’s Jev check (4m) and her queued investigation (2m) ONE Jev → LLM row, Queued', () => {
    // Arrange
    const jev: WardenJevBefore = { verdict: 'handed_on', why: 'unsure', at: at(4), confidence: 0.21, costUsd: 0.0041 };
    const status = {
      jevChecks: [check({ at: at(4), sessionId: 'maryah', anomalyKind: 'unattended_question', confidence: 0.21 })],
      investigations: [
        wardenInvestigation({
          id: 'queued:maryah',
          state: 'queued',
          targetSession: 'maryah',
          anomalyKind: 'unattended_question',
          queuedAt: at(2),
          jev,
        }),
      ],
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.who).toBe('jev_llm');
    expect(row.result).toMatchObject({ key: 'working', label: 'Queued' });
    expect(row.timeline.map(step => step.kind)).toEqual(['flag', 'jev', 'llm']);
  });

  it('should join a queued investigation to its Jev check even when its link points at another moment or names none', () => {
    // Arrange
    const askedFor = (jev?: WardenJevBefore) => ({
      jevChecks: [check({ at: at(4), sessionId: 'maryah', anomalyKind: 'unattended_question' })],
      investigations: [
        wardenInvestigation({
          id: 'queued:maryah',
          state: 'queued',
          targetSession: 'maryah',
          anomalyKind: 'unattended_question',
          queuedAt: at(2),
          ...(jev === undefined ? {} : { jev }),
        }),
      ],
    });

    // Act
    const drifted = only(askedFor({ verdict: 'handed_on', why: 'unsure', at: at(2), confidence: 0.2, costUsd: 0 }));
    const unlinked = only(askedFor());

    // Assert
    expect(drifted.who).toBe('jev_llm');
    expect(drifted.result.label).toBe('Queued');
    expect(unlinked.who).toBe('jev_llm');
    expect(unlinked.result.label).toBe('Queued');
  });

  it('should make Jaylynn’s Jev check (12m) and her running investigation (3m) ONE row, Investigating', () => {
    // Arrange
    const jev: WardenJevBefore = {
      verdict: 'handed_on',
      why: 'never_alone',
      act: 'stop',
      at: at(12),
      confidence: 0.99,
      costUsd: 0.0038,
    };
    const status = {
      jevChecks: [
        check({ at: at(12), sessionId: 'jaylynn', anomalyKind: 'dead_monitor', why: 'never_alone', act: 'stop' }),
      ],
      investigations: [
        wardenInvestigation({
          id: 'warden-jaylynn',
          state: 'running',
          targetSession: 'jaylynn',
          anomalyKind: 'dead_monitor',
          startedAt: at(3),
          agent: 'claude-default',
          model: 'sonnet',
          jev,
        }),
      ],
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.who).toBe('jev_llm');
    expect(row.result).toMatchObject({ key: 'working', busy: true });
    expect(row.runtime).toBe('claude-default · sonnet');
  });

  it('should not hand a check to an investigation of another flag, another ferret or one that began before it', () => {
    // Arrange
    const flagged = check({ at: at(10), sessionId: 'maryah', anomalyKind: 'unattended_question' });
    const queued = (overrides: Parameters<typeof wardenInvestigation>[0]) =>
      wardenInvestigation({ id: 'q', state: 'queued', queuedAt: at(2), ...overrides });

    // Act
    const otherFlag = rowsOf({
      jevChecks: [flagged],
      investigations: [queued({ targetSession: 'maryah', anomalyKind: 'dead_monitor' })],
    });
    const otherFerret = rowsOf({
      jevChecks: [flagged],
      investigations: [queued({ targetSession: 'jaylynn', anomalyKind: 'unattended_question' })],
    });
    const earlier = rowsOf({
      jevChecks: [flagged],
      investigations: [queued({ targetSession: 'maryah', anomalyKind: 'unattended_question', queuedAt: at(30) })],
    });

    // Assert
    expect(otherFlag).toHaveLength(2);
    expect(otherFerret).toHaveLength(2);
    expect(earlier).toHaveLength(2);
    expect(otherFlag.map(row => row.result.key).sort()).toEqual(['handed', 'working']);
  });

  it('should say which limit skipped a check no investigation followed, and never call it Handed to LLM', () => {
    // Arrange / Act
    const cap = only({ jevChecks: [check({ verdict: 'skipped', why: 'jev_cap', confidence: 0, costUsd: 0 })] });
    const paced = only({ jevChecks: [check({ verdict: 'skipped', why: 'jev_paced', confidence: 0, costUsd: 0 })] });
    const bare = only({ jevChecks: [check({ verdict: 'skipped', why: undefined, confidence: 0, costUsd: 0 })] });

    // Assert
    expect(cap.result).toMatchObject({ key: 'skipped', label: 'Skipped: daily cap' });
    expect(paced.result).toMatchObject({ key: 'skipped', label: 'Skipped: hourly share' });
    expect(bare.result).toMatchObject({ key: 'skipped', label: 'Skipped' });
  });

  it('should settle a Jev check with the act Jev made in that sweep', () => {
    // Arrange
    const status = {
      jevChecks: [check({ verdict: 'acted', act: 'nudge', route: undefined, confidence: 0.97 })],
      actions: [wardenAction({ at: at(59), by: 'jev', confidence: 0.97, anomalyKind: 'sus_thinking' })],
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.who).toBe('jev');
    expect(row.result.key).toBe('nudged');
    expect(row.timeline.map(step => step.kind)).toEqual(['flag', 'jev', 'act']);
    expect(row.timeline[1]?.detail).toContain('97% sure and acted: nudge it');
  });

  it('should not settle a check with a Jev act on another ferret, flag or sweep, or with a rule act', () => {
    // Arrange
    const status = {
      jevChecks: [check({ verdict: 'healthy', route: undefined })],
      actions: [
        wardenAction({ at: at(59), by: 'jev', sessionId: 'other', anomalyKind: 'sus_thinking' }),
        wardenAction({ at: at(59), by: 'jev', anomalyKind: 'agent_frozen' }),
        wardenAction({ at: at(30), by: 'jev', anomalyKind: 'sus_thinking' }),
        wardenAction({ at: at(59), by: 'warden', anomalyKind: 'sus_thinking' }),
      ],
    };

    // Act
    const rows = rowsOf(status);

    // Assert
    expect(rows).toHaveLength(5);
    expect(rows.filter(row => row.who === 'rule')).toHaveLength(1);
  });

  it('should take a Jev act with no flag recorded as settling the check on that ferret', () => {
    // Arrange
    const status = {
      jevChecks: [check({ verdict: 'acted', act: 'restart', route: undefined })],
      actions: [wardenAction({ at: at(60), by: 'jev', action: 'restart' })],
    };

    // Act / Assert
    expect(only(status).result.key).toBe('restarted');
  });

  it('should join a lone LLM act to the check it names, and leave a check it does not name', () => {
    // Arrange
    const jev: WardenJevBefore = { verdict: 'handed_on', at: at(60) };
    const status = {
      jevChecks: [
        check({ at: at(60) }),
        check({ at: at(60), sessionId: 'sess-2' }),
        check({ at: at(60), anomalyKind: 'agent_frozen' }),
      ],
      actions: [wardenAction({ at: at(30), reportPath: 'r/4.md', jev, anomalyKind: 'sus_thinking' })],
    };

    // Act
    const rows = rowsOf(status);

    // Assert
    expect(rows).toHaveLength(3);
    const joined = rows.find(row => row.reportPath === 'r/4.md');
    expect(joined?.who).toBe('jev_llm');
    expect(joined?.timeline.map(step => step.kind)).toEqual(['flag', 'jev', 'llm', 'act']);
  });

  it('should join a lone LLM act whose check was not kept, from the Jev line it carries', () => {
    // Arrange
    const withCost: WardenJevBefore = {
      verdict: 'handed_on',
      why: 'unsure',
      confidence: 0.3,
      costUsd: 0.002,
      at: at(60),
    };
    const noCost: WardenJevBefore = { verdict: 'not_asked', why: 'owner_request' };
    const zero: WardenJevBefore = { verdict: 'off', costUsd: 0 };

    // Act
    const a = only({ actions: [wardenAction({ reportPath: 'r/5.md', jev: withCost })] });
    const b = only({ actions: [wardenAction({ reportPath: 'r/6.md', jev: noCost })] });
    const c = only({ actions: [wardenAction({ reportPath: 'r/7.md', jev: zero })] });

    // Assert
    expect(a.who).toBe('jev_llm');
    expect(a.timeline[1]).toMatchObject({ kind: 'jev', cost: '$0.0020' });
    expect(a.timeline[1]?.time).toContain('UTC');
    expect(b.who).toBe('llm');
    expect(b.timeline[1]).toMatchObject({ kind: 'jev', detail: 'Jev: not asked — you asked for this' });
    expect(b.timeline[1]?.cost).toBeUndefined();
    expect(b.timeline[1]?.time).toBeUndefined();
    expect(c.timeline[1]?.cost).toBeUndefined();
  });

  it('should treat a skipped Jev as handing on, and an LLM act with no Jev record as LLM alone', () => {
    // Arrange
    const skipped: WardenJevBefore = { verdict: 'skipped', why: 'jev_cap' };

    // Act
    const a = only({ actions: [wardenAction({ reportPath: 'r/8.md', jev: skipped })] });
    const b = only({ actions: [wardenAction({ reportPath: 'r/9.md' })] });

    // Assert
    expect(a.who).toBe('jev_llm');
    expect(b.who).toBe('llm');
    expect(b.timeline.map(step => step.kind)).toEqual(['flag', 'llm', 'act']);
  });
});

describe('triggerRows: who, flag and runtime', () => {
  it('should read Jev, owner and rule as the actor of an act with no model behind it', () => {
    // Arrange / Act
    const jev = only({ actions: [wardenAction({ by: 'jev' })] });
    const owner = only({ actions: [wardenAction({ by: 'owner', action: 'bless', detail: 'Left longer.' })] });
    const rule = only({ actions: [wardenAction({ by: 'warden' })] });

    // Assert
    expect([jev.who, owner.who, rule.who]).toEqual(['jev', 'owner', 'rule']);
    expect(owner.whoLabel).toBe('You');
    expect(owner.result.key).toBe('left');
  });

  it('should name the flag from the check, the investigation, the act, the rule or nothing', () => {
    // Arrange / Act
    const fromCheck = only({ jevChecks: [check({ anomalyKind: 'agent_frozen' })] });
    const fromInvestigation = only({
      investigations: [wardenInvestigation({ startedAt: at(5), anomalyKind: 'dead_monitor' })],
    });
    const fromAct = only({ actions: [wardenAction({ anomalyKind: 'report_overdue' })] });
    const failover = only({ actions: [wardenAction({ action: 'failover' })] });
    const revive = only({ actions: [wardenAction({ action: 'revive' })] });
    const close = only({ actions: [wardenAction({ action: 'close_leftover' })] });
    const bare = only({ actions: [wardenAction({ action: 'bless' })] });

    // Assert
    expect(fromCheck.flag.label).toBe('frozen');
    expect(fromInvestigation.flag.label).toBe('pane lost');
    expect(fromAct.flag.label).toBe('no reply');
    expect(failover.flag.label).toBe('usage limit');
    expect(revive.flag.label).toBe('ferret died');
    expect(close.flag.label).toBe('leftover browser');
    expect(bare.flag.label).toBe('flagged');
    expect(only({ investigations: [wardenInvestigation({ startedAt: at(5) })] }).flag.label).toBe('flagged');
  });

  it('should show the runtime only when an investigation ran, with the login and model it recorded', () => {
    // Arrange / Act
    const both = only({
      investigations: [wardenInvestigation({ startedAt: at(5), agent: 'codex-main', model: 'gpt-6-astra' })],
    });
    const loginOnly = only({ investigations: [wardenInvestigation({ startedAt: at(5), agent: 'codex-main' })] });
    const none = only({ investigations: [wardenInvestigation({ startedAt: at(5) })] });
    const rule = only({ actions: [wardenAction({ by: 'warden' })] });

    // Assert
    expect(both.runtime).toBe('codex-main · gpt-6-astra');
    expect(loginOnly.runtime).toBe('codex-main');
    expect(none.runtime).toBeUndefined();
    expect(rule.runtime).toBeUndefined();
  });
});

describe('triggerRows: result', () => {
  it('should name every act, and a login move with the login it left and the one it reached', () => {
    // Arrange
    const kinds = ['bless', 'nudge', 'resume', 'revive', 'restart', 'stop', 'failover', 'close_leftover'] as const;

    // Act
    const labels = kinds.map(action => only({ actions: [wardenAction({ action })] }).result.label);
    const moved = only({
      actions: [wardenAction({ action: 'failover', agent: 'claude-llm1', fromAgent: 'claude-atomi' })],
    });
    const movedTo = only({ actions: [wardenAction({ action: 'failover', agent: 'claude-llm1' })] });

    // Assert
    expect(labels).toEqual([
      'Left alone',
      'Nudged',
      'Resumed',
      'Revived',
      'Restarted',
      'Stopped',
      'Moved login',
      'Closed browser',
    ]);
    expect(moved.result).toMatchObject({ key: 'moved', label: 'Moved login claude-atomi → claude-llm1' });
    expect(movedTo.result.label).toBe('Moved login → claude-llm1');
  });

  it('should say Held and Failed with their reason', () => {
    // Arrange / Act
    const held = only({ actions: [wardenAction({ outcome: 'held', detail: 'Waiting for you to allow stopping.' })] });
    const failed = only({ actions: [wardenAction({ outcome: 'failed', detail: 'The pane is gone.' })] });

    // Assert
    expect(held.result).toMatchObject({ key: 'held', label: 'Held', note: 'Waiting for you to allow stopping.' });
    expect(failed.result).toMatchObject({ key: 'failed', label: 'Failed', note: 'The pane is gone.' });
  });

  it('should show an investigation with no act by its state or its verdict', () => {
    // Arrange
    const row = (overrides: Parameters<typeof wardenInvestigation>[0]) =>
      only({ investigations: [wardenInvestigation({ startedAt: at(5), ...overrides })] }).result;

    // Act / Assert
    expect(row({ state: 'queued' })).toMatchObject({ key: 'working', label: 'Queued' });
    expect(row({ state: 'running' })).toMatchObject({ key: 'working', label: 'Investigating', busy: true });
    expect(row({ state: 'done', verdict: 'cleared' }).label).toBe('Left alone');
    expect(row({ state: 'done', verdict: 'needs_human' }).label).toBe('Asked you');
    expect(row({ state: 'done', verdict: 'killed' }).label).toBe('Stopped');
    expect(row({ state: 'done', verdict: 'nudged' }).label).toBe('Nudged');
    expect(row({ state: 'done', verdict: 'revived' }).label).toBe('Revived');
    expect(row({ state: 'done' }).label).toBe('Reviewed');
  });

  it('should show a check with no act by what Jev did: left, acted, asked you or handed on', () => {
    // Arrange / Act
    const healthy = only({ jevChecks: [check({ verdict: 'healthy', route: undefined })] });
    const acted = only({ jevChecks: [check({ verdict: 'acted', act: 'failover', route: undefined })] });
    const actedBare = only({ jevChecks: [check({ verdict: 'acted', route: undefined })] });
    const asked = only({ jevChecks: [check({ route: 'owner', why: 'never_alone', act: 'stop' })] });

    // Assert
    expect(healthy.result.key).toBe('left');
    expect(acted.result.key).toBe('moved');
    expect(actedBare.result.key).toBe('reviewed');
    expect(asked.result).toMatchObject({ key: 'asked' });
    expect(asked.result.note).toContain('stopping alone is off');
  });
});

describe('triggerRows: the timeline sentences', () => {
  const sentence = (overrides: Partial<WardenJevCheck>) => only({ jevChecks: [check(overrides)] }).timeline[1]?.detail;

  it('should say why Jev passed a flag on, for every reason', () => {
    // Arrange / Act / Assert
    expect(sentence({ why: 'unsure' })).toBe('Jev was not sure (40%), so it went to an investigation.');
    expect(sentence({ why: undefined })).toContain('Jev was not sure (40%)');
    expect(sentence({ why: 'not_sure_enough', act: 'nudge' })).toContain('only 40% sure it should nudge it');
    expect(sentence({ why: 'not_sure_enough' })).toContain('only 40% sure, below your bar');
    expect(sentence({ why: 'never_alone', act: 'failover' })).toContain('moving accounts alone is off');
    expect(sentence({ why: 'not_allowed' })).toContain('may not act alone');
    expect(sentence({ why: 'cannot_choose_login' })).toContain('cannot choose which');
    expect(sentence({ why: 'no_message' })).toContain('not sure enough of what to say');
    expect(sentence({ why: 'already_acted' })).toContain('already acted');
    expect(sentence({ why: 'not_offered' })).toContain('does not allow');
    expect(sentence({ why: 'failed' })).toContain('check failed');
    expect(sentence({ why: 'act_failed', act: 'resume' })).toContain('tried to resume it');
    expect(sentence({ why: 'act_failed' })).toContain('tried to act');
    expect(sentence({ why: 'jev_cap', verdict: 'skipped' })).toContain('daily cap is spent');
    expect(sentence({ why: 'jev_paced', verdict: 'skipped' })).toContain('this hour’s share');
    expect(sentence({ why: 'never_alone', route: 'owner' })).toContain('it waits for you');
    expect(sentence({ verdict: 'healthy', route: undefined })).toBe(
      'Jev was 40% sure it is healthy, so the flag was left.',
    );
    expect(sentence({ verdict: 'acted', route: undefined })).toBe('Jev was 40% sure and acted.');
  });

  it('should leave the cost off a skipped check, because Jev was never asked', () => {
    // Arrange / Act
    const skipped = only({ jevChecks: [check({ verdict: 'skipped', why: 'jev_cap' })] }).timeline[1];

    // Assert
    expect(skipped?.cost).toBeUndefined();
  });

  it('should time and describe the LLM step from the investigation, else from the act', () => {
    // Arrange
    const running = only({
      investigations: [
        wardenInvestigation({ startedAt: at(5), agent: 'claude-default', model: 'sonnet', wardenName: 'warden-0003' }),
      ],
    });
    const queued = only({ investigations: [wardenInvestigation({ state: 'queued', queuedAt: at(5) })] });
    const finished = only({
      investigations: [wardenInvestigation({ state: 'done', startedAt: at(9), finishedAt: at(3), verdict: 'cleared' })],
    });
    const fromAct = only({ actions: [wardenAction({ reportPath: 'r/x.md', investigator: 'warden-0009' })] });

    // Assert
    expect(running.timeline[1]).toMatchObject({
      label: `Investigated by ${displaySystemCallsign('warden-0003')}`,
      detail: 'claude-default · sonnet · running',
    });
    expect(queued.timeline[1]).toMatchObject({ label: 'Investigated', detail: 'queued' });
    expect(finished.timeline[1]?.detail).toBeUndefined();
    expect(finished.timeline[1]?.time).toContain('11:57');
    expect(fromAct.timeline[1]).toMatchObject({ label: `Investigated by ${displaySystemCallsign('warden-0009')}` });
  });

  it('should list every act of one investigation in time order', () => {
    // Arrange
    const status = {
      investigations: [wardenInvestigation({ state: 'done', startedAt: at(20), reportPath: 'r/y.md' })],
      actions: [
        wardenAction({ at: at(5), action: 'resume', reportPath: 'r/y.md', detail: 'Resumed it.' }),
        wardenAction({ at: at(10), action: 'nudge', reportPath: 'r/y.md', detail: 'Nudged it.' }),
      ],
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.timeline.filter(step => step.kind === 'act').map(step => step.detail)).toEqual([
      'Nudged it.',
      'Resumed it.',
    ]);
    expect(row.result.key).toBe('resumed');
  });
});

describe('triggerRows: ordering and repeats', () => {
  it('should order newest first by the trigger’s first moment', () => {
    // Arrange
    const status = {
      actions: [
        wardenAction({ at: at(30), sessionId: 'a', action: 'stop', detail: 'x' }),
        wardenAction({ at: at(10), sessionId: 'b', action: 'stop', detail: 'x' }),
      ],
    };

    // Act
    const rows = rowsOf(status);

    // Assert
    expect(rows.map(row => row.sessionId)).toEqual(['b', 'a']);
  });

  it('should fold consecutive triggers whose every column matches into ×N', () => {
    // Arrange
    const status = {
      actions: [at(30), at(20), at(10)].map(time => wardenAction({ at: time, by: 'jev' })),
    };

    // Act
    const row = only(status);

    // Assert
    expect(row.count).toBe(3);
    expect(row.times.map(time => time.compact)).toEqual(['10m', '20m', '30m']);
    expect(triggerTotal([row])).toBe(3);
  });

  it('should NOT fold across another trigger, or when any column differs', () => {
    // Arrange
    const same = { by: 'jev', action: 'nudge' } as const;
    const status = {
      actions: [
        wardenAction({ at: at(50), ...same }),
        wardenAction({ at: at(40), ...same, action: 'stop', detail: 'y' }),
        wardenAction({ at: at(30), ...same }),
        wardenAction({ at: at(20), ...same, sessionId: 'other' }),
        wardenAction({ at: at(10), ...same, sessionId: 'other', anomalyKind: 'agent_frozen' }),
        wardenAction({ at: at(9), ...same, sessionId: 'other', anomalyKind: 'agent_frozen', by: 'warden' }),
        wardenAction({
          at: at(8),
          ...same,
          sessionId: 'other',
          anomalyKind: 'agent_frozen',
          by: 'warden',
          outcome: 'held',
          detail: 'one',
        }),
        wardenAction({
          at: at(7),
          ...same,
          sessionId: 'other',
          anomalyKind: 'agent_frozen',
          by: 'warden',
          outcome: 'held',
          detail: 'two',
        }),
      ],
    };

    // Act
    const rows = rowsOf(status);

    // Assert
    expect(rows.map(row => row.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('should keep a runtime difference as a different trigger', () => {
    // Arrange
    const status = {
      investigations: [
        wardenInvestigation({ id: 'w1', state: 'done', startedAt: at(20), verdict: 'cleared', agent: 'a' }),
        wardenInvestigation({ id: 'w2', state: 'done', startedAt: at(10), verdict: 'cleared', agent: 'b' }),
      ],
    };

    // Act / Assert
    expect(rowsOf(status)).toHaveLength(2);
  });
});

describe('filters and paging', () => {
  const mixed = () =>
    rowsOf({
      actions: [
        wardenAction({ at: at(40), by: 'jev', action: 'nudge' }),
        wardenAction({ at: at(30), by: 'warden', action: 'failover', sessionId: 'b', agent: 'x' }),
        wardenAction({ at: at(20), by: 'warden', reportPath: 'r/z.md', action: 'stop', sessionId: 'c' }),
      ],
    });

  it('should filter by who and by result, and by both', () => {
    // Arrange
    const rows = mixed();

    // Act / Assert
    expect(filterTriggerRows(rows, NO_FILTERS)).toHaveLength(3);
    expect(filterTriggerRows(rows, { who: 'jev', result: 'all' }).map(row => row.sessionId)).toEqual(['sess-1']);
    expect(filterTriggerRows(rows, { who: 'all', result: 'moved' }).map(row => row.sessionId)).toEqual(['b']);
    expect(filterTriggerRows(rows, { who: 'llm', result: 'stopped' })).toHaveLength(1);
    expect(filterTriggerRows(rows, { who: 'rule', result: 'stopped' })).toHaveLength(0);
    expect(WHO_FILTERS.map(option => option.key)).toEqual(['all', 'rule', 'jev', 'jev_llm', 'llm']);
  });

  it('should list every result with how many triggers have it', () => {
    // Arrange
    const options = resultFilterOptions(mixed());

    // Act / Assert
    expect(options[0]).toEqual({ key: 'all', label: 'All results · 3' });
    expect(options.find(option => option.key === 'moved')?.label).toBe('Moved login · 1');
    expect(options.find(option => option.key === 'held')?.label).toBe('Held · 0');
    expect(options).toHaveLength(15);
  });

  it('should page by TRIGGERS_PAGE and report how many are hidden', () => {
    // Arrange
    const rows = rowsOf({
      actions: Array.from({ length: TRIGGERS_PAGE + 5 }, (_, index) =>
        wardenAction({ at: at(index + 1), sessionId: `s${index}` }),
      ),
    });

    // Act
    const first = pageTriggerRows(rows, 1);
    const second = pageTriggerRows(rows, 2);
    const zero = pageTriggerRows(rows, 0);

    // Assert
    expect(first.rows).toHaveLength(TRIGGERS_PAGE);
    expect(first.hidden).toBe(5);
    expect(second.hidden).toBe(0);
    expect(zero.rows).toHaveLength(TRIGGERS_PAGE);
  });
});
