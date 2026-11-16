import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretView, RuntimeModelCatalog, RuntimeSwitchAccount } from '@ferretry/core-ferrets/contract';
import { ClaudeHarness } from '../../../daemon/adapters/claude-harness.ts';
import {
  CLAUDE_RUNTIME_SWITCH,
  claudeFastModeFacts,
  claudeRuntimeCatalog,
  planClaudeSwitch,
  RUNTIME_EFFORT_LEVELS,
} from '../../../daemon/lib/harness/runtime-switch.ts';

/**
 * Claude Code's part of the live switch: what it is asked (a typed command), what it offers (its account's models), and what
 * it refuses before a key is pressed. It drives no picker, so there is nothing to recover.
 */

const CONTEXT = { wrapper: 'claude-auto', allowedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'] };

const ACCOUNT: RuntimeSwitchAccount = {
  agent: 'claude-auto',
  available: true,
  unavailableReason: null,
  defaultModel: 'claude-opus-5-5',
  models: [
    {
      id: 'claude-opus-5-5',
      displayName: 'Opus 5.5',
      tier: 'best',
      context: 200_000,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      available: true,
    },
    { id: 'claude-sonnet-5-5', available: true },
    { id: 'claude-haiku-5-5', available: false, unavailableReason: 'not on this plan' },
  ],
  modelCatalog: { id: 'anthropic', label: 'Anthropic', customIds: true },
};

describe('what a Claude Code ferret is asked to switch', () => {
  it('types /model for a model its account serves, and claims exactly that', () => {
    should(planClaudeSwitch({ harness: 'claude', model: ' claude-sonnet-5-5 ' }, CONTEXT)).eql({
      kind: 'inject',
      command: '/model claude-sonnet-5-5',
      requestedModel: 'claude-sonnet-5-5',
      claimsOutcome: true,
    });
  });

  it('refuses a model its account does not serve, unless the catalog takes custom ids and the id is one well-formed word', () => {
    const refusedPlan = planClaudeSwitch({ harness: 'claude', model: 'claude-other' }, CONTEXT);
    should(refusedPlan).eql({ kind: 'refused', reason: 'model claude-other is not available on wrapper claude-auto' });
    const custom = { ...CONTEXT, acceptsCustomModels: true };
    should(planClaudeSwitch({ harness: 'claude', model: 'claude-other' }, custom).kind).equal('inject');
    for (const hostile of ['a b', 'a;rm', '/x', 'a\nb', '', '-x'])
      should(planClaudeSwitch({ harness: 'claude', model: hostile }, custom).kind).equal('refused');
  });

  it('refuses a switch when the account serves nothing, and a blank model as no model', () => {
    should(planClaudeSwitch({ harness: 'claude', model: 'x' }, { wrapper: 'w', allowedModels: [] })).eql({
      kind: 'refused',
      reason: 'in-session model switching is not supported for wrapper w',
    });
    should(planClaudeSwitch({ harness: 'claude', model: '   ' }, CONTEXT)).eql({
      kind: 'refused',
      reason: 'a model is required for a runtime switch on this harness',
    });
    should(planClaudeSwitch({ harness: 'claude' }, { wrapper: 'w' }).kind).equal('refused');
  });

  it('types /effort for a level Claude Code takes, and refuses any other', () => {
    for (const level of RUNTIME_EFFORT_LEVELS)
      should(planClaudeSwitch({ harness: 'claude', effort: level }, CONTEXT)).eql({
        kind: 'inject',
        command: `/effort ${level}`,
        requestedEffort: level,
        claimsOutcome: true,
      });
    should(planClaudeSwitch({ harness: 'claude', effort: 'ultra' }, CONTEXT)).eql({
      kind: 'refused',
      reason: 'effort must be one of low, medium, high, xhigh, max',
    });
  });

  it('refuses a model and an effort together rather than applying one and dropping the other', () => {
    const plan = planClaudeSwitch({ harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, CONTEXT);
    should(plan.kind).equal('refused');
    should(JSON.stringify(plan)).match(/one at a time/u);
  });

  it('names the state wanted for fast mode, and refuses it on a model with none before anything is typed', () => {
    should(planClaudeSwitch({ harness: 'claude', fast: true }, { ...CONTEXT, fast: { supported: true } })).eql({
      kind: 'inject',
      command: '/fast on',
      requestedFast: true,
      claimsOutcome: true,
    });
    should(planClaudeSwitch({ harness: 'claude', fast: false }, CONTEXT)).eql({
      kind: 'inject',
      command: '/fast off',
      requestedFast: false,
      claimsOutcome: true,
    });
    should(
      planClaudeSwitch(
        { harness: 'claude', fast: true },
        { ...CONTEXT, fast: { supported: false, model: 'Sonnet 5.5' } },
      ),
    ).eql({
      kind: 'refused',
      reason: 'Sonnet 5.5 has no fast mode',
    });
    should(planClaudeSwitch({ harness: 'claude', fast: true }, { ...CONTEXT, fast: { supported: false } })).eql({
      kind: 'refused',
      reason: 'this model has no fast mode',
    });
    should(planClaudeSwitch({ harness: 'claude', fast: true, model: 'x' }, CONTEXT).kind).equal('refused');
    should(planClaudeSwitch({ harness: 'claude', fast: true, effort: 'high' }, CONTEXT).kind).equal('refused');
  });
});

describe('what a Claude Code ferret offers', () => {
  it('lists only the models its account may be asked for, with their levels, the default and the fast rule on the id', () => {
    const catalog = claudeRuntimeCatalog(ACCOUNT);
    should(catalog).eql({
      harness: 'claude',
      source: 'wrapper-inventory',
      choices: [
        {
          value: 'claude-opus-5-5',
          label: 'Opus 5.5',
          tier: 'best',
          context: 200_000,
          fast: true,
          isDefault: true,
          reasoningEfforts: [{ value: 'high' }, { value: 'max' }],
          defaultReasoningEffort: 'high',
        },
        { value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', fast: false, reasoningEfforts: [] },
      ],
      catalog: { id: 'anthropic', label: 'Anthropic', customIds: true },
    });
  });

  it('lists nothing for an account that is down, and carries no catalog note when the account has none', () => {
    should(claudeRuntimeCatalog({ ...ACCOUNT, available: false, unavailableReason: 'signed out' }).choices).eql([]);
    const { modelCatalog: _gone, ...bare } = ACCOUNT;
    should(claudeRuntimeCatalog(bare)).not.have.property('catalog');
  });

  it('says whether the model in force has fast mode, by its catalog entry, then by the rule on its id', () => {
    const catalog: RuntimeModelCatalog = claudeRuntimeCatalog(ACCOUNT);
    const view = (model: string | undefined, observed?: string) =>
      ({
        config: { ...(model === undefined ? {} : { model }) },
        state: { ...(observed === undefined ? {} : { observedModel: observed }) },
      }) as unknown as FerretView;
    should(claudeFastModeFacts(view('claude-sonnet-5-5'), catalog)).eql({
      supported: false,
      model: 'claude-sonnet-5-5',
    });
    // What the pane runs wins over what it launched with, and a `[1m]` selector is not part of the id.
    should(claudeFastModeFacts(view('claude-sonnet-5-5', 'claude-opus-5-5[1m]'), catalog)).eql({
      supported: true,
      model: 'Opus 5.5',
    });
    // A model its catalog does not list is judged by the rule on its id, and called by it.
    should(claudeFastModeFacts(view('claude-opus-5-9'), catalog)).eql({ supported: true, model: 'claude-opus-5-9' });
    should(claudeFastModeFacts(view(undefined), catalog)).eql({});
  });

  it('recovers from nothing, because it never opens a picker, and the harness hands the one switch to every pane', async () => {
    should(await CLAUDE_RUNTIME_SWITCH.quirks.recoverFromFailedDrive('s1', new Error('x'))).eql({ kind: 'recovered' });
    should(
      CLAUDE_RUNTIME_SWITCH.quirks.report({
        needsHumanKind: 'codex_picker_cleanup',
        reason: 'r',
        needsHuman: 'look at it',
        evidence: { driveError: 'd', cleanupError: 'c' },
      }),
    ).equal('look at it');
    should(CLAUDE_RUNTIME_SWITCH.catalogs).not.have.property('pickerDriver');
    should(CLAUDE_RUNTIME_SWITCH).not.have.property('liveCatalog');
    // The member is served by a part composed per instance now, so the harness is built (its parts touch no dependency here).
    const harness = new ClaudeHarness({} as never);
    should(harness.runtimeSwitch()).equal(CLAUDE_RUNTIME_SWITCH);
  });
});
