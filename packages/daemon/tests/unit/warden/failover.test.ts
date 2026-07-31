import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyWardenFailure,
  confirmedUsableAccount,
  DEFAULT_WARDEN_FAILOVER,
  effectiveFailoverConfig,
  ineligibilityReason,
  isDemoted,
  normalizeWardenAccounts,
  reconcileDemotions,
  recordWardenFailure,
  recordWardenSuccess,
  selectWardenAccount,
  usableAccount,
  type WardenFailoverState,
  type WardenSelectionInput,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const input = (overrides: Partial<WardenSelectionInput> = {}): WardenSelectionInput => ({
  accounts: ['first', 'second', 'third'],
  installedAgents: ['first', 'second', 'third'],
  usage: [],
  state: {},
  nowMs: NOW,
  ...overrides,
});

describe('failover configuration', () => {
  it('should apply defaults when nothing is configured', () => {
    // Arrange / Act / Assert
    should(effectiveFailoverConfig()).eql(DEFAULT_WARDEN_FAILOVER);
  });

  it('should let a partial override win over the defaults', () => {
    // Arrange / Act
    const config = effectiveFailoverConfig({ policy: 'round_robin' });

    // Assert
    should(config.policy).eql('round_robin');
    should(config.failureThreshold).eql(DEFAULT_WARDEN_FAILOVER.failureThreshold);
  });
});

describe('account normalisation', () => {
  it('should expand string shorthand', () => {
    // Arrange / Act / Assert
    should(normalizeWardenAccounts(['one', 'two'])).eql([{ agent: 'one' }, { agent: 'two' }]);
  });

  it('should keep the first occurrence and its model when a name repeats', () => {
    // Arrange
    const entries = [{ agent: 'one', model: 'fast' }, 'one', { agent: 'one', model: 'slow' }];

    // Act / Assert
    should(normalizeWardenAccounts(entries)).eql([{ agent: 'one', model: 'fast' }]);
  });

  it.each([
    { label: 'a blank name', entries: [{ agent: '   ' }] },
    { label: 'an empty shorthand', entries: [''] },
  ])('should drop $label', ({ entries }) => {
    // Arrange / Act / Assert
    should(normalizeWardenAccounts(entries)).be.empty();
  });

  it('should trim surrounding whitespace from a name', () => {
    // Arrange / Act / Assert
    should(normalizeWardenAccounts([' padded '])).eql([{ agent: 'padded' }]);
  });
});

describe('account health predicates', () => {
  it.each([
    { label: 'an unscored account', health: undefined, usable: true, confirmed: false },
    {
      label: 'an account the feed says is fine',
      health: { agent: 'a', atLimit: false },
      usable: true,
      confirmed: true,
    },
    { label: 'an account at its limit', health: { agent: 'a', atLimit: true }, usable: false, confirmed: false },
    {
      label: 'an account with bad credentials',
      health: { agent: 'a', authOk: false },
      usable: false,
      confirmed: false,
    },
    {
      label: 'an account whose provider is down',
      health: { agent: 'a', atLimit: false, unavailable: true },
      usable: false,
      confirmed: false,
    },
    { label: 'an account the feed only partly scored', health: { agent: 'a' }, usable: true, confirmed: false },
  ])('should judge $label', ({ health, usable, confirmed }) => {
    // Arrange / Act / Assert
    should(usableAccount(health)).eql(usable);
    should(confirmedUsableAccount(health)).eql(confirmed);
  });
});

describe('account eligibility', () => {
  it('should accept an account nothing is known against', () => {
    // Arrange / Act / Assert
    should(ineligibilityReason({ agent: 'first' }, input())).be.undefined();
  });

  it('should refuse an account missing from a non-empty inventory', () => {
    // Arrange / Act
    const reason = ineligibilityReason({ agent: 'ghost' }, input());

    // Assert
    should(reason).eql('not installed on this host');
  });

  it('should not condemn anyone when the inventory is unreadable', () => {
    // Arrange / Act
    const reason = ineligibilityReason({ agent: 'ghost' }, input({ installedAgents: [] }));

    // Assert
    should(reason).be.undefined();
  });

  it('should refuse an account whose credentials were rejected', () => {
    // Arrange / Act
    const reason = ineligibilityReason({ agent: 'first' }, input({ usage: [{ agent: 'first', authOk: false }] }));

    // Assert
    should(reason).eql('credentials rejected (usage feed)');
  });

  it('should refuse an account at its usage limit', () => {
    // Arrange / Act
    const reason = ineligibilityReason({ agent: 'first' }, input({ usage: [{ agent: 'first', atLimit: true }] }));

    // Assert
    should(reason).eql('at its usage limit (usage feed)');
  });

  it('should explain an unavailable provider and when to retry', () => {
    // Arrange
    const usage = [{ agent: 'first', unavailable: true, unavailableReason: 'spend_limit', retryAt: NOW + 60_000 }];

    // Act
    const reason = ineligibilityReason({ agent: 'first' }, input({ usage }));

    // Assert
    should(reason).eql(`provider unavailable: spend limit; retry after ${at(1)} (usage feed)`);
  });

  it('should still explain an unavailable provider that named no cause', () => {
    // Arrange / Act
    const reason = ineligibilityReason({ agent: 'first' }, input({ usage: [{ agent: 'first', unavailable: true }] }));

    // Assert
    should(reason).eql('provider unavailable: provider (usage feed)');
  });

  it('should refuse an account still inside its demotion cooldown', () => {
    // Arrange
    const state: WardenFailoverState = { demotedUntil: { first: at(10) } };

    // Act / Assert
    should(isDemoted(state, 'first', NOW)).be.true();
    should(ineligibilityReason({ agent: 'first' }, input({ state }))).eql(`demoted until ${at(10)}`);
  });

  it.each([
    { label: 'an elapsed cooldown', until: at(-10) },
    { label: 'an unparseable cooldown', until: 'whenever' },
    { label: 'no record at all', until: undefined },
  ])('should not treat $label as a demotion', ({ until }) => {
    // Arrange
    const state: WardenFailoverState = until === undefined ? {} : { demotedUntil: { first: until } };

    // Act / Assert
    should(isDemoted(state, 'first', NOW)).be.false();
  });
});

describe('account selection', () => {
  it('should pick the configured first choice when it is healthy', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input());

    // Assert
    should(selection.exhausted).be.false();
    if (selection.exhausted) return;
    should(selection.account.agent).eql('first');
    should(selection.reason).eql('preferred');
    should(selection.skipped).eql({});
  });

  it('should fail over past an ineligible first choice and say why', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input({ usage: [{ agent: 'first', atLimit: true }] }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.account.agent).eql('second');
    should(selection.reason).eql('failover');
    should(selection.skipped).eql({ first: 'at its usage limit (usage feed)' });
  });

  it('should fail back automatically once the first choice recovers', () => {
    // Arrange
    const demoted = selectWardenAccount(input({ state: { demotedUntil: { first: at(10) } } }));

    // Act
    const recovered = selectWardenAccount(input({ state: { demotedUntil: { first: at(-10) } } }));

    // Assert
    if (demoted.exhausted || recovered.exhausted) throw new Error('expected selections');
    should(demoted.account.agent).eql('second');
    should(recovered.account.agent).eql('first');
  });

  it('should record the selection on the returned state', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input());

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.state.lastSelection).eql({
      agent: 'first',
      policy: 'fallback',
      at: at(0),
      reason: 'preferred',
    });
  });

  it('should not advance a cursor under the fallback policy', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input({ state: { rrCursor: 2 } }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.state.rrCursor).eql(2);
  });

  it('should rotate through the configured list under round robin', () => {
    // Arrange
    const failover = { policy: 'round_robin' as const };
    let state: WardenFailoverState = {};
    const picked: string[] = [];

    // Act
    for (let turn = 0; turn < 4; turn += 1) {
      const selection = selectWardenAccount(input({ failover, state }));
      if (selection.exhausted) throw new Error('expected a selection');
      picked.push(selection.account.agent);
      state = selection.state;
    }

    // Assert
    should(picked).eql(['first', 'second', 'third', 'first']);
  });

  it('should keep everyone else in turn order when one account drops out', () => {
    // Arrange
    const failover = { policy: 'round_robin' as const };
    const usage = [{ agent: 'second', atLimit: true }];

    // Act
    const selection = selectWardenAccount(input({ failover, usage, state: { rrCursor: 0 } }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.account.agent).eql('third');
    should(selection.state.rrCursor).eql(2);
    should(selection.reason).eql('rotation');
  });

  it('should wrap a cursor that points past the end of the list', () => {
    // Arrange — nine wraps to index 0, so the next turn is index 1.
    const selection = selectWardenAccount(input({ failover: { policy: 'round_robin' }, state: { rrCursor: 9 } }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.account.agent).eql('second');
  });

  it('should wrap a negative cursor back into the list', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input({ failover: { policy: 'round_robin' }, state: { rrCursor: -4 } }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.account.agent).eql('first');
  });

  it('should treat a nonsense cursor as no cursor at all', () => {
    // Arrange / Act
    const selection = selectWardenAccount(
      input({ failover: { policy: 'round_robin' }, state: { rrCursor: Number.NaN } }),
    );

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.account.agent).eql('first');
  });

  it('should report exhaustion with a reason for every account', () => {
    // Arrange
    const usage = [
      { agent: 'first', atLimit: true },
      { agent: 'second', authOk: false },
      { agent: 'third', unavailable: true, unavailableReason: 'auth' },
    ];

    // Act
    const selection = selectWardenAccount(input({ usage }));

    // Assert
    should(selection.exhausted).be.true();
    if (!selection.exhausted) return;
    should(Object.keys(selection.reasons)).eql(['first', 'second', 'third']);
    should(selection.state.exhaustedSince).eql(at(0));
  });

  it('should report exhaustion when no account is configured at all', () => {
    // Arrange / Act
    const selection = selectWardenAccount(input({ accounts: [] }));

    // Assert
    should(selection.exhausted).be.true();
  });

  it('should keep the instant exhaustion first began rather than restamping it', () => {
    // Arrange
    const state: WardenFailoverState = { exhaustedSince: at(-60) };

    // Act
    const selection = selectWardenAccount(input({ accounts: [], state }));

    // Assert
    if (!selection.exhausted) throw new Error('expected exhaustion');
    should(selection.state.exhaustedSince).eql(at(-60));
  });

  it('should clear exhaustion on the next successful selection', () => {
    // Arrange
    const state: WardenFailoverState = { exhaustedSince: at(-60) };

    // Act
    const selection = selectWardenAccount(input({ state }));

    // Assert
    if (selection.exhausted) throw new Error('expected a selection');
    should(selection.state.exhaustedSince).be.undefined();
    should('exhaustedSince' in selection.state).be.false();
  });
});

describe('failure classification', () => {
  it.each([
    { label: 'a quota message', message: 'account is at its usage limit', expected: 'quota' },
    { label: 'a rejected-credentials message', message: 'credentials were rejected', expected: 'auth' },
    { label: 'an auth-failure message', message: 'auth failure talking to the CLI', expected: 'auth' },
    { label: 'an unavailable provider', message: 'the provider is unavailable right now', expected: 'provider' },
    { label: 'anything else', message: 'tmux refused to open a pane', expected: 'generic' },
  ])('should classify $label', ({ message, expected }) => {
    // Arrange / Act / Assert
    should(classifyWardenFailure(message)).eql(expected);
  });
});

describe('failure and success bookkeeping', () => {
  it('should demote on a single corroborated failure', () => {
    // Arrange / Act
    const record = recordWardenFailure({}, 'first', 'quota', 'at its usage limit', NOW, { cooldownMinutes: 30 });

    // Assert
    should(record.demoted).be.true();
    should(record.strikes).eql(1);
    should(record.state.demotedUntil?.first).eql(at(30));
  });

  it('should need consecutive strikes before demoting on a generic failure', () => {
    // Arrange
    const failover = { failureThreshold: 3, cooldownMinutes: 10 };

    // Act
    const first = recordWardenFailure({}, 'first', 'generic', 'tmux died', NOW, failover);
    const second = recordWardenFailure(first.state, 'first', 'generic', 'tmux died', NOW, failover);
    const third = recordWardenFailure(second.state, 'first', 'generic', 'tmux died', NOW, failover);

    // Assert
    should([first.demoted, second.demoted, third.demoted]).eql([false, false, true]);
    should(third.strikes).eql(3);
    should(third.state.demotedUntil?.first).eql(at(10));
  });

  it('should record the evidence behind the latest strike', () => {
    // Arrange / Act
    const record = recordWardenFailure({}, 'first', 'generic', 'tmux died', NOW);

    // Assert
    should(record.state.strikes?.first).eql({ count: 1, lastAt: at(0), lastReason: 'tmux died' });
  });

  it('should clamp a threshold below one so a generic failure still demotes', () => {
    // Arrange / Act
    const record = recordWardenFailure({}, 'first', 'generic', 'tmux died', NOW, {
      failureThreshold: 0,
      cooldownMinutes: 5,
    });

    // Assert
    should(record.demoted).be.true();
  });

  it('should clamp a negative cooldown to an immediate expiry', () => {
    // Arrange / Act
    const record = recordWardenFailure({}, 'first', 'auth', 'rejected', NOW, { cooldownMinutes: -60 });

    // Assert
    should(record.state.demotedUntil?.first).eql(at(0));
  });

  it('should leave other accounts untouched when one fails', () => {
    // Arrange
    const state: WardenFailoverState = { strikes: { second: { count: 2, lastAt: at(-5), lastReason: 'earlier' } } };

    // Act
    const record = recordWardenFailure(state, 'first', 'generic', 'tmux died', NOW);

    // Assert
    should(record.state.strikes?.second?.count).eql(2);
  });

  it('should clear strikes and demotion after a successful spawn', () => {
    // Arrange
    const state: WardenFailoverState = {
      strikes: { first: { count: 2, lastAt: at(-5), lastReason: 'tmux died' } },
      demotedUntil: { first: at(30) },
    };

    // Act
    const next = recordWardenSuccess(state, 'first');

    // Assert
    should(next.strikes?.first).be.undefined();
    should(next.demotedUntil?.first).be.undefined();
  });

  it('should return the same state when a success clears nothing', () => {
    // Arrange
    const state: WardenFailoverState = { rrCursor: 1 };

    // Act / Assert
    should(recordWardenSuccess(state, 'first')).be.exactly(state);
  });
});

describe('demotion reconciliation', () => {
  it('should restore an account the feed positively confirms', () => {
    // Arrange
    const state: WardenFailoverState = {
      demotedUntil: { first: at(30) },
      strikes: { first: { count: 3, lastAt: at(-5), lastReason: 'quota' } },
    };

    // Act
    const result = reconcileDemotions(state, [{ agent: 'first', atLimit: false, authOk: true }], NOW);

    // Assert
    should(result.restored).eql([{ agent: 'first', how: 'feed' }]);
    should(result.state.demotedUntil?.first).be.undefined();
    should(result.state.strikes?.first).be.undefined();
  });

  it('should prune a demotion whose cooldown has elapsed', () => {
    // Arrange
    const state: WardenFailoverState = { demotedUntil: { first: at(-1) } };

    // Act
    const result = reconcileDemotions(state, [], NOW);

    // Assert
    should(result.restored).eql([{ agent: 'first', how: 'cooldown' }]);
    should(result.state.demotedUntil?.first).be.undefined();
  });

  it('should prune a demotion whose expiry is unreadable rather than latch forever', () => {
    // Arrange
    const state: WardenFailoverState = { demotedUntil: { first: 'whenever' } };

    // Act
    const result = reconcileDemotions(state, [], NOW);

    // Assert
    should(result.restored).eql([{ agent: 'first', how: 'cooldown' }]);
  });

  it('should keep strikes when a demotion merely expired', () => {
    // Arrange
    const state: WardenFailoverState = {
      demotedUntil: { first: at(-1) },
      strikes: { first: { count: 3, lastAt: at(-5), lastReason: 'tmux died' } },
    };

    // Act
    const result = reconcileDemotions(state, [], NOW);

    // Assert
    should(result.state.strikes?.first?.count).eql(3);
  });

  it('should leave a live demotion the feed does not contradict alone', () => {
    // Arrange
    const state: WardenFailoverState = { demotedUntil: { first: at(30) } };

    // Act
    const result = reconcileDemotions(state, [{ agent: 'first', atLimit: true }], NOW);

    // Assert
    should(result.restored).be.empty();
    should(result.state).be.exactly(state);
  });

  it('should not restore on a merely unknown account', () => {
    // Arrange
    const state: WardenFailoverState = { demotedUntil: { first: at(30) } };

    // Act
    const result = reconcileDemotions(state, [{ agent: 'first' }], NOW);

    // Assert
    should(result.restored).be.empty();
  });

  it('should do nothing when nothing is demoted', () => {
    // Arrange
    const state: WardenFailoverState = { rrCursor: 1 };

    // Act
    const result = reconcileDemotions(state, [], NOW);

    // Assert
    should(result.state).be.exactly(state);
    should(result.restored).be.empty();
  });
});
