import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_LANE_MODES,
  defaultAccountSummary,
  defaultAccountsFor,
  defaultInstructionsName,
  derivedWrapperName,
  FLEET_DEFAULT_LANES,
  FLEET_STARTER_MODELS,
} from '../../src/lib/defaults.ts';
import { canonicalAssetReference } from '../../src/lib/paths.ts';

describe('derivedWrapperName', () => {
  it('should keep the bare name for the default lane and spell every other one out', () => {
    // Assert — one rule for the default fleet and for anything a person adds later, so
    // `claude-auto-default` is the same kind of name as `claude-auto-work`.
    should(derivedWrapperName('claude', 'default', 'default')).equal('claude-default');
    should(derivedWrapperName('claude', 'default', 'auto')).equal('claude-auto-default');
    should(derivedWrapperName('codex', 'work', 'auto')).equal('codex-auto-work');
  });
});

describe('defaultAccountsFor', () => {
  it('should give a harness nothing until it was actually detected', () => {
    // Assert — this is what makes running the decision on every start safe: "should anything be
    // created" is answered by what was found, not by a flag somebody has to set.
    should(defaultAccountsFor([])).be.empty();
  });

  it('should give a host with only claude exactly the two claude accounts', () => {
    // Act
    const accounts = defaultAccountsFor(['claude']);

    // Assert
    should(accounts.map(account => account.wrapper)).deepEqual(['claude-default', 'claude-auto-default']);
    should(accounts.every(account => account.kind === 'claude')).be.true();
  });

  it('should order by harness then lane, interactive first, whatever order it was asked in', () => {
    // Act — the order reaches a person: it is the order the boot names them in and the order a
    // configuration declares them in, so a set that reordered itself would make a diff unreadable.
    const accounts = defaultAccountsFor(['codex', 'claude']);

    // Assert
    should(accounts.map(account => account.wrapper)).deepEqual([
      'claude-default',
      'claude-auto-default',
      'codex-default',
      'codex-auto-default',
    ]);
  });

  it('should give every account a home that is its own wrapper name', () => {
    // Assert — two strings that must always agree are one string: a home that drifted from its
    // wrapper would publish credentials under a directory no surface names.
    for (const account of defaultAccountsFor(['claude', 'codex'])) should(account.home).equal(account.wrapper);
  });

  it('should publish the mode its lane declares, and the starter model its harness declares', () => {
    // Act
    const accounts = defaultAccountsFor(['claude', 'codex']);

    // Assert — `mode` is what consumers read to decide whether an account may be driven unattended.
    for (const account of accounts) {
      should(account.mode).equal(DEFAULT_LANE_MODES[account.lane]);
      should(account.defaultModel).equal(FLEET_STARTER_MODELS[account.kind]);
    }
    should(accounts.filter(account => account.mode === 'auto').map(account => account.wrapper)).deepEqual([
      'claude-auto-default',
      'codex-auto-default',
    ]);
  });

  it('should name each account for a person, distinguishing the unattended lane', () => {
    // Assert
    should(defaultAccountsFor(['claude', 'codex']).map(account => account.displayName)).deepEqual([
      'Claude (default)',
      'Claude (default, auto)',
      'Codex (default)',
      'Codex (default, auto)',
    ]);
  });

  it('should carry the instructions document each account reads, per harness and per lane', () => {
    // Assert — "configured by default" is one fact rather than two hopeful ones: the thing that
    // writes these documents and the thing that points accounts at them read this table.
    for (const account of defaultAccountsFor(['claude', 'codex'])) {
      should(account.instructions).equal(DEFAULT_INSTRUCTIONS[account.kind][account.lane]);
    }
  });

  it('should occupy exactly the declared lanes, so a third lane cannot appear silently', () => {
    // Assert
    should(defaultAccountsFor(['claude']).map(account => account.lane)).deepEqual([...FLEET_DEFAULT_LANES]);
    should(new Set(defaultAccountsFor(['claude', 'codex']).map(account => account.wrapper)).size).equal(4);
  });

  it('should share one provider-account name across both lanes of a harness', () => {
    // Assert — one agent per harness with two homes on it, which is what makes signing in once
    // enough for both.
    for (const account of defaultAccountsFor(['claude', 'codex'])) {
      should(account.wrapper).endWith(DEFAULT_ACCOUNT_NAME);
    }
  });
});

describe('defaultInstructionsName', () => {
  it('should name the default lane after its harness and every other lane after both', () => {
    // Assert
    should(defaultInstructionsName('claude', 'default')).equal('claude');
    should(defaultInstructionsName('claude', 'auto')).equal('claude-auto');
    should(defaultInstructionsName('codex', 'default')).equal('codex');
    should(defaultInstructionsName('codex', 'auto')).equal('codex-auto');
  });

  it('should give every declared document a distinct name and a distinct path', () => {
    // Act
    const entries = (['claude', 'codex'] as const).flatMap(kind =>
      FLEET_DEFAULT_LANES.map(lane => ({
        name: defaultInstructionsName(kind, lane),
        path: canonicalAssetReference(DEFAULT_INSTRUCTIONS[kind][lane]),
      })),
    );

    // Assert — the configuration refuses two names for one path, so a collision here would make the
    // starter configuration unparseable.
    should(new Set(entries.map(entry => entry.name)).size).equal(4);
    should(new Set(entries.map(entry => entry.path)).size).equal(4);
  });

  it('should point each harness at the document that harness reads under its own name', () => {
    // Assert — Codex reading a document called CLAUDE.md is the defect the four-document table
    // exists to remove.
    should(DEFAULT_INSTRUCTIONS.claude.default).equal('./CLAUDE.md');
    should(DEFAULT_INSTRUCTIONS.claude.auto).equal('./CLAUDE-auto.md');
    should(DEFAULT_INSTRUCTIONS.codex.default).equal('./AGENTS.md');
    should(DEFAULT_INSTRUCTIONS.codex.auto).equal('./AGENTS-auto.md');
  });
});

describe('defaultAccountSummary', () => {
  it('should say the names rather than a count', () => {
    // Assert — "2 accounts created" tells a person nothing they can act on; the names are what they
    // type and what they search for when they want the files gone.
    should(defaultAccountSummary(defaultAccountsFor(['claude']))).equal('claude-default, claude-auto-default');
    should(defaultAccountSummary([])).equal('');
  });
});
