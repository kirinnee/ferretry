import { afterEach, describe, it } from 'bun:test';
import type { RuntimeModelChoice } from '@ferretry/protocol';
import should from 'should';
import {
  SessionForkTargetResolutionError,
  SessionForkTargetResolver,
  type SessionForkTargetAccount,
  forkStartupRuntimeRequest,
} from '../../../src/adapters/fork/session-fork-target-resolver.ts';
import { CodexRuntimeCatalogCache } from '../../../src/lib/session/harness/codex-catalog-cache.ts';
import {
  type HarnessRuntimeSwitchContext,
  type HarnessRuntimeSwitchRequest,
  planRuntimeSwitch,
} from '../../../src/lib/session/harness/runtime-switch.ts';
import type { TransferTargetChoice } from '../../../src/lib/transfer/types.ts';
import { account, cleanup, planner } from './fixtures.ts';

/**
 * What a fork's target actually resolves to, and — just as load-bearing — what it refuses.
 *
 * Two properties beyond the field list. The harness must be the RESOLVED account's declared family
 * rather than anything derived from the caller's string, and every effort/model rule must come from
 * the one runtime-switch planner over the one held Codex catalogue. A second effort list or a second
 * probe would not fail any assertion about the returned value, so both are asserted directly: the
 * request handed to the planner, and the number of times the account was actually probed.
 */

const CATALOG: readonly RuntimeModelChoice[] = [
  {
    value: 'gpt-5.6-terra',
    label: 'terra',
    reasoningEfforts: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    defaultReasoningEffort: 'high',
  },
  {
    // No advanced level to reach, so choosing this row applies its preset directly: the switch
    // planner answers `quickPickerAppliesPreset`, which is a preflight instruction and NOT a refusal.
    value: 'gpt-5.6-sol',
    label: 'sol',
    reasoningEfforts: [{ value: 'low' }, { value: 'high' }],
    defaultReasoningEffort: 'low',
  },
];

/** The one quirk service's decision, with the exact request and context it was asked recorded. */
function switchPlanner(): {
  readonly harness: { planSwitch: typeof planRuntimeSwitch };
  readonly asked: { request: HarnessRuntimeSwitchRequest; context: HarnessRuntimeSwitchContext }[];
} {
  const asked: { request: HarnessRuntimeSwitchRequest; context: HarnessRuntimeSwitchContext }[] = [];
  return {
    harness: {
      planSwitch: (request, context) => {
        asked.push({ request, context });
        return planRuntimeSwitch(request, context);
      },
    },
    asked,
  };
}

function probe(choices: readonly RuntimeModelChoice[] = CATALOG): {
  readonly cache: CodexRuntimeCatalogCache;
  readonly calls: { binary: string; cwd: string }[];
} {
  const calls: { binary: string; cwd: string }[] = [];
  const cache = new CodexRuntimeCatalogCache(async (binary, cwd) => {
    calls.push({ binary, cwd });
    return choices;
  });
  return { cache, calls };
}

function resolver(
  accounts: (agent: string) => Promise<SessionForkTargetAccount>,
  parts: {
    readonly harness?: { planSwitch: typeof planRuntimeSwitch };
    readonly catalog?: CodexRuntimeCatalogCache;
  } = {},
): SessionForkTargetResolver {
  return new SessionForkTargetResolver({
    accounts,
    planner: planner(),
    harness: parts.harness ?? switchPlanner().harness,
    catalog: parts.catalog ?? probe().cache,
  });
}

const CLAUDE: SessionForkTargetAccount = { account: account(), executable: '/fleet/bin/claude-auto-zelda' };
const CODEX: SessionForkTargetAccount = {
  account: account({
    id: 'acct-codex',
    agent: 'codex-auto-terra',
    kind: 'codex',
    wrapper: '/fleet/bin/codex-auto-terra',
    defaultModel: 'gpt-5.6-terra',
    models: [
      { id: 'gpt-5.6-terra', available: true },
      { id: 'gpt-5.6-sol', available: true },
    ],
  }),
  executable: '/fleet/bin/codex-auto-terra',
};

const served = (resolved: SessionForkTargetAccount) => async () => resolved;

/** One already-resolved target choice, as a frozen plan carries it. */
function choice(overrides: Partial<TransferTargetChoice> = {}): TransferTargetChoice {
  return {
    accountId: 'acct-target',
    agent: 'claude-auto-zelda',
    harness: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
    contextWindow: 1_000_000,
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<SessionForkTargetResolutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionForkTargetResolutionError) return error;
    throw error;
  }
  throw new Error('expected the resolution to be refused, but it resolved');
}

describe('SessionForkTargetResolver', () => {
  afterEach(async () => await cleanup());

  it('should answer with the resolved account, its declared harness and the planner-owned model', async () => {
    // Arrange
    const catalogue = probe();

    // Act
    const decided = await resolver(served(CLAUDE), { catalog: catalogue.cache }).resolve({
      agent: 'claude-auto-zelda',
      model: 'claude-opus-5',
      effort: 'high',
    });

    // Assert: exactly the six fields the plan carries, and no Codex probe for a harness that takes
    // its effort as a native command.
    should(decided).eql({
      accountId: 'acct-target',
      agent: 'claude-auto-zelda',
      harness: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      contextWindow: 1_000_000,
    });
    should(catalogue.calls).eql([]);
  });

  it('should take the harness from the account rather than from the agent the caller spelled', async () => {
    // Arrange: the wrapper name says claude, the published account declares codex.
    const misleading: SessionForkTargetAccount = {
      account: account({ id: 'acct-codex', agent: 'claude-auto-zelda', kind: 'codex', defaultModel: 'gpt-5.6-terra' }),
      executable: '/fleet/bin/claude-auto-zelda',
    };

    // Act
    const decided = await resolver(served(misleading)).resolve({
      agent: 'claude-auto-zelda',
      model: null,
      effort: null,
    });

    // Assert
    should(decided.harness).equal('codex');
  });

  it('should refuse a model the account cannot serve, rather than freezing its default instead', async () => {
    // Act — the planner still owns the decision and there is still no second rule here; what changed
    // is that its decision may be a REFUSAL, and this resolver answers with it.
    const refused = await refusal(
      resolver(served(CLAUDE)).resolve({ agent: 'claude-auto-zelda', model: 'sonnet-3', effort: null }),
    );

    // Assert: the substitution was invisible because the choice FROZE the substitute, so the binder's
    // later drift comparison had nothing to disagree with and the fork ran a model nobody named.
    should(refused.failure).equal('agent_unavailable');
    should(refused.message).match(/does not serve model "sonnet-3"/u);
    should(refused.message).match(/It serves claude-opus-5/u);
  });

  it('should probe no catalogue while resolving, because the target directory is not known yet', async () => {
    // Arrange
    const decisions = switchPlanner();
    const catalogue = probe();

    // Act
    await resolver(served(CODEX), { harness: decisions.harness, catalog: catalogue.cache }).resolve({
      agent: 'codex-auto-terra',
      model: 'gpt-5.6-terra',
      effort: 'max',
    });

    // Assert: resolution answers what the target IS; proving the account can serve it is `validate`,
    // and it cannot run until preparation has frozen the working directory.
    should(catalogue.calls).eql([]);
    should(decisions.asked).eql([]);
  });
});

describe('SessionForkTargetResolver.validate', () => {
  afterEach(async () => await cleanup());

  it('should validate a Claude effort against the runtime levels and refuse one outside them', async () => {
    // Arrange
    const decisions = switchPlanner();
    const subject = resolver(served(CLAUDE), { harness: decisions.harness });

    // Act
    await subject.validate(choice({ harness: 'claude', model: 'claude-opus-5', effort: 'xhigh' }), '/work/repo');
    const refused = await refusal(
      subject.validate(choice({ harness: 'claude', model: 'claude-opus-5', effort: 'ultra' }), '/work/repo'),
    );

    // Assert: the effort-only request the harness's own command takes, and the planner's own words.
    should(decisions.asked.map(ask => ask.request)).eql([
      { harness: 'claude', effort: 'xhigh' },
      { harness: 'claude', effort: 'ultra' },
    ]);
    should(decisions.asked[0]?.context.catalog).equal(undefined);
    should(refused.failure).equal('agent_unavailable');
    should(refused.message).match(/low, medium, high, xhigh/u);
  });

  it('should read the one live catalogue in the directory the plan froze, once per account', async () => {
    // Arrange
    const decisions = switchPlanner();
    const catalogue = probe();
    const subject = resolver(served(CODEX), { harness: decisions.harness, catalog: catalogue.cache });
    const target = choice({
      accountId: 'acct-codex',
      agent: 'codex-auto-terra',
      harness: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'max',
    });

    // Act: two attempts at the same fork, in the target's own working directory.
    await subject.validate(target, '/work/repo');
    await subject.validate({ ...target, effort: 'low' }, '/work/repo');

    // Assert: the picker request carries the model with the effort, the probe runs in the TARGET's
    // directory rather than one this daemon guessed, and the held cache answered the second read.
    should(decisions.asked.map(ask => ask.request)).eql([
      { harness: 'codex', model: 'gpt-5.6-terra', effort: 'max' },
      { harness: 'codex', model: 'gpt-5.6-terra', effort: 'low' },
    ]);
    should(decisions.asked[0]?.context.catalog?.choices.map(advertised => advertised.value)).eql([
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
    should(catalogue.calls).eql([{ binary: '/fleet/bin/codex-auto-terra', cwd: '/work/repo' }]);
  });

  it('should re-read the catalogue for a different working directory rather than reuse one', async () => {
    // Arrange: the cache is keyed by (executable, cwd) precisely because a project can configure its
    // own catalogue, which is the whole reason validation waits for the frozen directory.
    const catalogue = probe();
    const subject = resolver(served(CODEX), { catalog: catalogue.cache });
    const target = choice({
      accountId: 'acct-codex',
      agent: 'codex-auto-terra',
      harness: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'max',
    });

    // Act
    await subject.validate(target, '/work/one');
    await subject.validate(target, '/work/two');

    // Assert
    should(catalogue.calls.map(call => call.cwd)).eql(['/work/one', '/work/two']);
  });

  it('should ask nothing at all when the fork chose no effort', async () => {
    // Arrange
    const decisions = switchPlanner();
    const catalogue = probe();

    // Act
    await resolver(served(CODEX), { harness: decisions.harness, catalog: catalogue.cache }).validate(
      choice({ harness: 'codex', model: 'gpt-5.6-terra', effort: null }),
      '/work/repo',
    );

    // Assert: there is no runtime control to prove, so there is nothing to refuse either.
    should(decisions.asked).eql([]);
    should(catalogue.calls).eql([]);
  });

  it('should accept a Codex target whose quick picker would apply a preset', async () => {
    // Arrange: `gpt-5.6-sol` advertises no advanced level, so the quick row applies its own preset.
    const decisions = switchPlanner();

    // Act
    await resolver(served(CODEX), { harness: decisions.harness }).validate(
      choice({
        accountId: 'acct-codex',
        agent: 'codex-auto-terra',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      }),
      '/work/repo',
    );

    // Assert: a preflight instruction is not a refusal — the account can serve this fork.
    const plan = planRuntimeSwitch(decisions.asked[0]?.request ?? { harness: 'codex' }, {
      wrapper: 'codex-auto-terra',
      catalog: { choices: CATALOG },
    });
    should(plan.kind).equal('drive_picker');
    should(plan.kind === 'drive_picker' && plan.target.quickPickerAppliesPreset).equal(true);
  });

  it('should refuse an effort the live Codex catalogue does not advertise for the chosen model', async () => {
    // Act
    const refused = await refusal(
      resolver(served(CODEX)).validate(
        choice({
          accountId: 'acct-codex',
          agent: 'codex-auto-terra',
          harness: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'max',
        }),
        '/work/repo',
      ),
    );

    // Assert
    should(refused.failure).equal('agent_unavailable');
    should(refused.message).match(/max is not advertised for Codex model gpt-5\.6-sol/u);
  });

  it('should refuse when the live catalogue cannot be read at all', async () => {
    // Arrange
    const cache = new CodexRuntimeCatalogCache(async () => {
      throw new Error('app-server handshake timed out');
    });

    // Act
    const refused = await refusal(
      resolver(served(CODEX), { catalog: cache }).validate(
        choice({
          accountId: 'acct-codex',
          agent: 'codex-auto-terra',
          harness: 'codex',
          model: 'gpt-5.6-terra',
          effort: 'high',
        }),
        '/work/repo',
      ),
    );

    // Assert: unreadable is not empty, and it is the account that cannot serve rather than an unknown one.
    should(refused.failure).equal('agent_unavailable');
    should(refused.message).match(/could not be read/u);
    should(refused.message).match(/app-server handshake timed out/u);
  });

  it('should refuse a target whose agent no longer resolves to the account it was decided for', async () => {
    // Act
    const refused = await refusal(
      resolver(served(CLAUDE)).validate(
        choice({ accountId: 'acct-withdrawn', agent: 'claude-auto-zelda', harness: 'claude', effort: 'high' }),
        '/work/repo',
      ),
    );

    // Assert
    should(refused.failure).equal('agent_unavailable');
    should(refused.message).match(/now resolves to account acct-target/u);
  });

  it('should keep an unknown agent and an unavailable one apart', async () => {
    // Arrange: the composition root's own resolution raises a failure-coded refusal.
    const unknown = async () => {
      throw Object.assign(new Error('no account is published as "ghost"'), { failure: 'unknown_agent' });
    };
    const down = async () => {
      throw Object.assign(new Error('wrapper is not on this host'), { failure: 'unavailable' });
    };
    const broken = async () => {
      throw new Error('the fleet manifest is present and cannot be read');
    };

    // Act
    const missing = await refusal(resolver(unknown).resolve({ agent: 'ghost', model: null, effort: null }));
    const unavailable = await refusal(
      resolver(down).resolve({ agent: 'claude-auto-zelda', model: null, effort: null }),
    );
    const damaged = await refusal(resolver(broken).resolve({ agent: 'claude-auto-zelda', model: null, effort: null }));

    // Assert: only the explicit unknown-agent code is read as one; everything else fails closed.
    should(missing.failure).equal('unknown_agent');
    should(missing.message).equal('no account is published as "ghost"');
    should(unavailable.failure).equal('agent_unavailable');
    should(damaged.failure).equal('agent_unavailable');
    should(damaged.message).equal('the fleet manifest is present and cannot be read');
  });
});

describe('forkStartupRuntimeRequest', () => {
  it('should follow the harness rather than the caller, and ask for nothing when no effort was chosen', () => {
    // Act & assert: one owner for what the resolver validates and what the binder later applies.
    should(forkStartupRuntimeRequest('claude', 'claude-opus-5', 'high')).eql({ action: 'effort', effort: 'high' });
    should(forkStartupRuntimeRequest('codex', 'gpt-5.6-terra', 'high')).eql({
      action: 'model',
      model: 'gpt-5.6-terra',
      effort: 'high',
    });
    // A picker harness with no model still names the level it must reach; the switch planner refuses
    // it, which is why the resolver asks before anything is created.
    should(forkStartupRuntimeRequest('codex', null, 'high')).eql({ action: 'model', effort: 'high' });
    should(forkStartupRuntimeRequest('claude', 'claude-opus-5', null)).equal(undefined);
  });
});
