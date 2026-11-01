import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '@ferretry/protocol';
import should from 'should';
import {
  autoMigrateHoldKey,
  chooseFailoverTarget,
  chooseMoveTarget,
  EMPTY_AUTO_MIGRATE_MEMORY,
  headroomRefusal,
  movesInLastHour,
  moveTriggers,
  providerOf,
  pruneAutoMigrateMemory,
  rankMoveTargets,
  rateLimitedSubjects,
  recordMove,
  triedLine,
} from '../../../src/lib/warden/auto-migrate.ts';
import type { WardenSessionView } from '../../../src/lib/warden/types.ts';
import { credential, facts, runtime, tool } from '../pack/support.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const config = (changes: Partial<WardenConfig['autoMigrate']> = {}, enabled = true): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  enabled,
  autoMigrate: { ...DEFAULT_WARDEN_CONFIG.autoMigrate, enabled: true, ...changes },
});

function session(id: string, overrides: Partial<WardenSessionView['config']> = {}, status = 'rate_limited') {
  return {
    config: { id, mode: 'auto', agent: 'claude-a-wrapper', harness: 'claude', ...overrides },
    state: { status },
    hasLiveMonitor: true,
  } as WardenSessionView;
}

describe('moveTriggers', () => {
  it('should answer no trigger while the Warden or moving is off', () => {
    // Act
    const wardenOff = moveTriggers(config({}, false));
    const movingOff = moveTriggers(config({ enabled: false }));
    const on = moveTriggers(config({ when: ['budget_exceeded'] }));

    // Assert
    should([...wardenOff]).deepEqual([]);
    should([...movingOff]).deepEqual([]);
    should([...on]).deepEqual(['budget_exceeded']);
  });
});

describe('rateLimitedSubjects', () => {
  it('should take only live rate-limited ferrets, never a warden or one with no recorded login', () => {
    // Arrange
    const fleet = [
      session('limited'),
      session('running', {}, 'running'),
      session('warden', { label: 'fleet-warden' }),
      session('spawned-by-warden', { wardenLineage: true }),
      session('no-login', { agent: undefined }),
    ];

    // Act
    const subjects = rateLimitedSubjects(fleet, config());

    // Assert
    should(subjects).deepEqual([
      {
        id: 'limited',
        agent: 'claude-a-wrapper',
        harness: 'claude',
        mode: 'auto',
        trigger: 'rate_limited',
      },
    ]);
  });

  it('should take none when rate limits are not a trigger', () => {
    // Act
    const subjects = rateLimitedSubjects([session('limited')], config({ when: ['budget_exceeded'] }));

    // Assert
    should(subjects).deepEqual([]);
  });
});

describe('providerOf', () => {
  it('should read a catalog as its provider, a native login as its harness provider, and nothing else as shared', () => {
    // Act
    const catalogued = providerOf(runtime('glm', { catalogId: 'zai' }));
    const nativeClaude = providerOf(runtime('claude-a'));
    const nativeCodex = providerOf(runtime('codex-a', { harness: 'codex' }));
    const handMade = providerOf(runtime('proxy', { credential: { id: 'proxy-login', store: 'environment' } }));

    // Assert
    should(catalogued).equal('zai');
    should(nativeClaude).equal('anthropic');
    should(nativeCodex).equal('openai');
    should(handMade).equal('login:proxy-login');
  });
});

describe('chooseMoveTarget', () => {
  const claudeTool = tool('claude', true);
  const source = { agent: 'claude-a-wrapper', harness: 'claude' as const };
  const exhausted = credential('claude-a-login', {
    usage: { fiveHour: { usedPercent: 100, resetsAt: iso(NOW + 3_600_000) }, weekly: {} },
  });

  it('should pick the ready login of the same harness and provider with the most headroom', () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-a'),
        runtime('claude-b'),
        runtime('claude-c'),
        runtime('codex-a', { harness: 'codex' }),
        runtime('glm', { catalogId: 'zai' }),
      ],
      credentials: [
        exhausted,
        credential('claude-b-login', { usage: { fiveHour: { usedPercent: 70 }, weekly: {} } }),
        credential('claude-c-login', { usage: { fiveHour: { usedPercent: 10 }, weekly: {} } }),
        credential('glm-login'),
      ],
      tools: [claudeTool],
      now: iso(NOW),
    });

    // Act
    const choice = chooseMoveTarget({ source, facts: known, targets: [], minHeadroomPercent: 20 });

    // Assert
    should(choice.kind).equal('chosen');
    should(choice.kind === 'chosen' ? choice.runtime.name : undefined).equal('claude-c');
    should(choice.tried).deepEqual([
      { runtime: 'glm', why: 'another provider (zai), which only a named target may reach' },
    ]);
  });

  it('should never pick a login that is switched off, over its budget, or out of quota, and say why for each', () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-a'),
        runtime('claude-off', { disabled: { source: 'runtime' }, launch: { available: false, reason: 'disabled' } }),
        runtime('claude-spent'),
        runtime('claude-held'),
      ],
      credentials: [
        exhausted,
        credential('claude-off-login'),
        credential('claude-spent-login', {
          usage: { fiveHour: { usedPercent: 100, resetsAt: iso(NOW + 3_600_000) }, weekly: {} },
        }),
        credential('claude-held-login', {
          budget: {
            level: 'over_trigger',
            daily: { level: 'over_trigger', spentUsd: 41.2, trigger: 40, resetsAt: '2026-11-02T00:00:00.000Z' },
          } as never,
        }),
      ],
      tools: [claudeTool],
      now: iso(NOW),
    });

    // Act
    const choice = chooseMoveTarget({ source, facts: known, targets: [], minHeadroomPercent: 20 });

    // Assert
    should(choice.kind).equal('none');
    should(choice.tried.map(entry => entry.runtime)).deepEqual(['claude-off', 'claude-spent', 'claude-held']);
    should(choice.tried[0]?.why).match(/disabled/);
    should(choice.tried[1]?.why).match(/out of quota|100%/);
    should(choice.tried[2]?.why).match(/daily trigger/);
  });

  it('should never move a ferret onto another runtime of the same login, which is the one out of quota', () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-a'),
        runtime('claude-a2', { credential: { id: 'claude-a-login', store: 'ferretry' } }),
      ],
      credentials: [credential('claude-a-login')],
      tools: [claudeTool],
    });

    // Act
    const choice = chooseMoveTarget({ source, facts: known, targets: [], minHeadroomPercent: 20 });

    // Assert
    should(choice).deepEqual({
      kind: 'none',
      tried: [{ runtime: 'claude-a2', why: 'it shares the login claude-a-login, the one that ran out' }],
    });
  });

  it("should follow the owner's list in order, crossing provider only for a login it names", () => {
    // Arrange
    const known = facts({
      runtimes: [runtime('claude-a'), runtime('claude-b'), runtime('glm', { catalogId: 'zai' })],
      credentials: [
        credential('claude-a-login'),
        credential('claude-b-login', { usage: { fiveHour: { usedPercent: 1 }, weekly: {} } }),
        credential('glm-login'),
      ],
      tools: [claudeTool],
    });

    // Act
    const choice = chooseMoveTarget({
      source,
      facts: known,
      targets: ['missing', 'glm', 'claude-b'],
      minHeadroomPercent: 20,
    });

    // Assert
    should(choice.kind === 'chosen' ? choice.runtime.name : undefined).equal('glm');
    should(choice.tried).deepEqual([{ runtime: 'missing', why: 'there is no runtime by that name on this machine' }]);
  });

  it('should refuse a named login of another harness', () => {
    // Arrange
    const known = facts({
      runtimes: [runtime('claude-a'), runtime('codex-a', { harness: 'codex' })],
      credentials: [credential('claude-a-login'), credential('codex-a-login', { harness: 'codex' })],
      tools: [claudeTool, tool('codex', true)],
    });

    // Act
    const choice = chooseMoveTarget({ source, facts: known, targets: ['codex-a'], minHeadroomPercent: 20 });

    // Assert
    should(choice).deepEqual({ kind: 'none', tried: [{ runtime: 'codex-a', why: 'it runs codex, not claude' }] });
  });

  it('should refuse every target, named ones too, when the login the ferret is on is not a runtime here', () => {
    // Arrange
    const known = facts({ runtimes: [runtime('claude-b')], credentials: [credential('claude-b-login')] });
    const expected = {
      kind: 'none',
      tried: [{ runtime: 'gone', why: 'it is not a runtime on this machine, so its login and provider are unknown' }],
    };

    // Act
    const any = chooseMoveTarget({
      source: { agent: 'gone', harness: 'claude' },
      facts: known,
      targets: [],
      minHeadroomPercent: 20,
    });
    const named = chooseMoveTarget({
      source: { agent: 'gone', harness: 'claude' },
      facts: known,
      targets: ['claude-b'],
      minHeadroomPercent: 20,
    });

    // Assert
    should(any).deepEqual(expected);
    should(named).deepEqual(expected);
  });
});

describe('the headroom floor', () => {
  const claudeTool = tool('claude', true);
  const source = { agent: 'claude-a-wrapper', harness: 'claude' as const };
  const used = (percent: number) => ({ usage: { fiveHour: { usedPercent: percent }, weekly: {} } });
  const known = facts({
    runtimes: [runtime('claude-a'), runtime('claude-b'), runtime('claude-c'), runtime('claude-d')],
    credentials: [
      credential('claude-a-login', used(100)),
      credential('claude-b-login', used(85)),
      credential('claude-c-login', used(60)),
      credential('claude-d-login'),
    ],
    tools: [claudeTool],
    now: iso(NOW),
  });

  it('should turn a login below the floor away with the share it has left, and rank the others', () => {
    // Act
    const { ready, tried } = rankMoveTargets({ source, facts: known, targets: [], minHeadroomPercent: 20 });

    // Assert
    should(ready.map(entry => entry.name)).deepEqual(['claude-d', 'claude-c']);
    should(tried).have.length(1);
    should(tried[0]?.runtime).equal('claude-b');
    should(tried[0]?.why).match(/^only 15% is left \(.*\), under the 20% the Warden settings require/);
    should(tried[0]?.why).match(/autoMigrate\.minHeadroomPercent/);
  });

  it('should have no floor at 0, and not hold an unmeasured login to one', () => {
    // Act
    const none = rankMoveTargets({ source, facts: known, targets: [], minHeadroomPercent: 0 });
    const unmeasured = headroomRefusal(runtime('claude-d'), known, 90);
    const low = headroomRefusal(runtime('claude-b'), known, 16);
    const enough = headroomRefusal(runtime('claude-b'), known, 15);

    // Assert
    should(none.ready.map(entry => entry.name)).deepEqual(['claude-d', 'claude-c', 'claude-b']);
    should(unmeasured).equal(undefined);
    should(low).match(/^only 15% is left/);
    should(enough).equal(undefined);
  });

  it('should refuse a named login below the floor too', () => {
    // Act
    const choice = chooseMoveTarget({ source, facts: known, targets: ['claude-b'], minHeadroomPercent: 20 });

    // Assert
    should(choice.kind).equal('none');
    should(choice.tried[0]?.why).match(/^only 15% is left/);
  });
});

describe('chooseFailoverTarget', () => {
  const claudeTool = tool('claude', true);
  const source = { agent: 'claude-a-wrapper', harness: 'claude' as const };
  const used = (percent: number) => ({ usage: { fiveHour: { usedPercent: percent }, weekly: {} } });
  const known = facts({
    runtimes: [
      runtime('claude-a'),
      runtime('claude-b'),
      runtime('claude-c'),
      runtime('claude-spent'),
      runtime('glm', { catalogId: 'zai' }),
    ],
    credentials: [
      credential('claude-a-login', used(100)),
      credential('claude-b-login', used(10)),
      credential('claude-c-login', used(50)),
      credential('claude-spent-login', used(100)),
      credential('glm-login'),
    ],
    tools: [claudeTool],
    now: iso(NOW),
  });
  const choose = (named: string, targets: readonly string[] = []) =>
    chooseFailoverTarget({ source, facts: known, targets, minHeadroomPercent: 20, named });

  it('should take the login the verdict named when the rules allow it', () => {
    // Act
    const choice = choose('claude-c');

    // Assert
    should(choice.kind === 'chosen' ? choice.runtime.name : undefined).equal('claude-c');
    should(choice.kind === 'chosen' ? choice.refusedNamed : 'none').equal(undefined);
  });

  it('should fall back to the best login when the named one has no quota, and say what was refused', () => {
    // Act
    const choice = choose('claude-spent');

    // Assert
    should(choice.kind === 'chosen' ? choice.runtime.name : undefined).equal('claude-b');
    should(choice.kind === 'chosen' ? choice.refusedNamed?.runtime : undefined).equal('claude-spent');
    should(choice.tried[0]?.runtime).equal('claude-spent');
    should(choice.tried.filter(entry => entry.runtime === 'claude-spent')).have.length(1);
  });

  it('should refuse a name that is no runtime here, and a login of another provider the owner did not name', () => {
    // Act
    const missing = choose('nowhere');
    const foreign = choose('glm');
    const allowed = choose('glm', ['glm']);

    // Assert
    should(missing.kind === 'chosen' ? missing.refusedNamed?.why : undefined).equal(
      'there is no runtime by that name on this machine',
    );
    should(foreign.kind === 'chosen' ? foreign.refusedNamed?.runtime : undefined).equal('glm');
    should(allowed.kind === 'chosen' ? allowed.runtime.name : undefined).equal('glm');
  });

  it('should keep a verdict inside the list the owner set, same provider or not', () => {
    // Act
    const unlisted = choose('claude-c', ['claude-b']);
    const listed = choose('claude-b', ['claude-b']);

    // Assert
    should(unlisted.kind === 'chosen' ? unlisted.runtime.name : undefined).equal('claude-b');
    should(unlisted.kind === 'chosen' ? unlisted.refusedNamed?.why : undefined).equal(
      'it is not in the autoMigrate.targets the owner set',
    );
    should(listed.kind === 'chosen' ? listed.refusedNamed : 'none').equal(undefined);
  });

  it('should refuse with every reason when nothing qualifies, and when the ferret is on no known login', () => {
    // Arrange
    const bare = facts({
      runtimes: [runtime('claude-a'), runtime('claude-spent')],
      credentials: [credential('claude-a-login', used(100)), credential('claude-spent-login', used(100))],
      tools: [claudeTool],
      now: iso(NOW),
    });

    // Act
    const none = chooseFailoverTarget({
      source,
      facts: bare,
      targets: [],
      minHeadroomPercent: 20,
      named: 'claude-spent',
    });
    const unknown = chooseFailoverTarget({
      source: { agent: 'gone', harness: 'claude' },
      facts: bare,
      targets: [],
      minHeadroomPercent: 20,
      named: 'claude-spent',
    });

    // Assert
    should(none.kind).equal('none');
    should(none.tried.map(entry => entry.runtime)).deepEqual(['claude-spent']);
    should(unknown.kind).equal('none');
    should(unknown.tried[0]?.runtime).equal('gone');
  });
});

describe('triedLine', () => {
  it('should say every login tried and why, in one line', () => {
    // Act
    const line = triedLine([
      { runtime: 'claude-b', why: 'its login is out of quota' },
      { runtime: 'glm', why: 'another provider (zai), which only a named target may reach' },
    ]);
    const none = triedLine([]);

    // Assert
    should(line).equal(
      'Tried claude-b (its login is out of quota); glm (another provider (zai), which only a named target may reach).',
    );
    should(none).equal('No other login of the same harness is set up on this machine.');
  });
});

describe('the move ledger', () => {
  it('should count only the moves of the last hour', () => {
    // Arrange
    let memory = recordMove(EMPTY_AUTO_MIGRATE_MEMORY, 's1', NOW - 2 * 3_600_000);
    memory = recordMove(memory, 's1', NOW - 10 * 60_000);

    // Act
    const count = movesInLastHour(memory, 's1', NOW);
    const other = movesInLastHour(memory, 's2', NOW);

    // Assert
    should(count).equal(1);
    should(other).equal(0);
  });

  it('should forget ferrets that are gone and moves older than an hour', () => {
    // Arrange
    let memory = recordMove(EMPTY_AUTO_MIGRATE_MEMORY, 'gone', NOW);
    memory = recordMove(memory, 'live', NOW - 2 * 3_600_000);
    memory = recordMove(memory, 'live', NOW - 60_000);

    // Act
    const pruned = pruneAutoMigrateMemory(memory, new Set(['live']), NOW);

    // Assert
    should(Object.keys(pruned.sessions)).deepEqual(['live']);
    should(pruned.sessions.live?.moves).deepEqual([iso(NOW - 60_000)]);
  });

  it('should key a hold by trigger, login and reason, so a standing reason is told once', () => {
    // Act
    const key = autoMigrateHoldKey({ trigger: 'rate_limited', agent: 'claude-a' }, 'no_target');

    // Assert
    should(key).equal('rate_limited|claude-a|no_target');
  });
});
