import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_CONTEXT_WINDOW,
  EXTENDED_CONTEXT_WINDOW,
  SessionPlanner,
  defaultStartWaitPolicy,
  type SessionPlan,
  type SessionPlanRequest,
  type SessionPlannerPolicy,
} from '../../../src/lib/core/index.ts';
import { account } from './fixtures.ts';

const policy = (overrides: Partial<SessionPlannerPolicy> = {}): SessionPlannerPolicy => ({
  startWait: defaultStartWaitPolicy,
  contextWindowOverrides: {},
  namePrefix: 'fyd',
  remoteControlPrefix: 'fyd',
  ...overrides,
});

/**
 * The plan, or a loud failure naming the refusal.
 *
 * Unwrapping here rather than in each test is what keeps a refusal from being mistaken for a plan
 * whose fields are all `undefined` — every assertion below is about a session that WAS planned.
 */
const planFor = (planner: SessionPlanner, request: SessionPlanRequest): SessionPlan => {
  const outcome = planner.plan(request);
  if (outcome.kind !== 'planned') throw new Error(`the planner refused to plan this session: ${outcome.reason}`);
  return outcome.plan;
};

const claude = account({
  id: 'account-primary',
  agent: 'agent-primary',
  displayName: 'Primary',
  defaultModel: 'apex',
  models: [
    { id: 'apex', available: true },
    { id: 'apex[1m]', available: true },
  ],
});

const codex = account({ ...claude, id: 'account-codex', kind: 'codex' });

describe('SessionPlanner', () => {
  it('should name the session from its identity and account, tmux-safely', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), { id: 'ab/cd', account: claude, mode: 'auto' });

    // Assert
    should(plan.tmuxName).equal('fyd-ab-cd-agent-primary');
  });

  it('should title the harness window with the teammate and the task', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
      teammate: 'mary-jane',
      name: 'Port The Usage Feed',
    });

    // Assert
    should(plan.title).equal('[Mary-Jane] Port The Usage Feed');
  });

  it('should inherit the launching session as parent for unattended work', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
      environmentSessionId: 'session-parent',
    });

    // Assert
    should(plan.parent).equal('session-parent');
  });

  it("should not parent a human's own terminal under whichever agent typed the command", () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), {
      id: 'session-1',
      account: claude,
      mode: 'interactive',
      environmentSessionId: 'session-parent',
    });

    // Assert
    should(plan.parent).be.undefined();
  });

  it("should report the account's default model when the caller names none", () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), { id: 'session-1', account: claude, mode: 'auto' });

    // Assert
    should(plan.model).equal('apex');
    should(plan.modelSource).equal('account-default');
  });

  it('should size the context window from the model the session will really run', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
      requestedModel: 'apex[1m]',
    });

    // Assert — the extended marker only ever appears in the configured id
    should(plan.contextWindow).equal(EXTENDED_CONTEXT_WINDOW);
  });

  it('should prefer a configured override over the marker convention', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy({ contextWindowOverrides: { apex: 300_000 } })), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
    });

    // Assert
    should(plan.contextWindow).equal(300_000);
  });

  it('should believe a window the harness reports about itself', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy({ contextWindowOverrides: { apex: 300_000 } })), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
      reportedWindow: 128_000,
    });

    // Assert
    should(plan.contextWindow).equal(128_000);
  });

  it('should fall back to the ordinary window when nothing says otherwise', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), { id: 'session-1', account: claude, mode: 'auto' });

    // Assert
    should(plan.contextWindow).equal(DEFAULT_CONTEXT_WINDOW);
  });

  it('should hold the launch open for the policy window', () => {
    // Arrange
    const slow = policy({ startWait: { ...defaultStartWaitPolicy, slowAccountIds: ['account-primary'] } });

    // Act / Assert
    should(planFor(new SessionPlanner(slow), { id: 's', account: claude, mode: 'auto' }).startWaitMs).equal(90_000);
    should(planFor(new SessionPlanner(policy()), { id: 's', account: claude, mode: 'auto' }).startWaitMs).equal(45_000);
  });

  it('should label the remote-control surface with the teammate it belongs to', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), {
      id: 'session-1',
      account: claude,
      mode: 'auto',
      teammate: 'hayden',
    });

    // Assert
    should(plan.extraArgs).containEql('fyd-hayden');
  });

  it('should add no remote-control surface to a harness that has none', () => {
    // Arrange / Act
    const plan = planFor(new SessionPlanner(policy()), { id: 'session-1', account: codex, mode: 'auto' });

    // Assert
    should(plan.extraArgs).eql([]);
  });

  it('should measure consumption against the window it assigned, not a guessed one', () => {
    // Arrange
    const planner = new SessionPlanner(policy());
    const plan = planFor(planner, { id: 'session-1', account: claude, mode: 'auto', requestedModel: 'apex[1m]' });

    // Act / Assert — 100k of a 1M window is 10%, not the 50% a default-sized window would report
    should(planner.contextUsedPercent(plan, 100_000)).equal(10);
  });

  it('should REFUSE to plan a session for a model the account cannot serve, rather than plan a different one', () => {
    // Arrange — the substitution was invisible precisely because a plan came back: this planner used to
    // answer `forge` with the account's default `apex`, and everything downstream — the `--model`
    // argument, the context window, the session document — then described `apex` while the caller's own
    // request survived only as a hint nobody refuses on.
    const planner = new SessionPlanner(policy());

    // Act
    const outcome = planner.plan({ id: 'session-1', account: claude, mode: 'auto', requestedModel: 'forge' });

    // Assert — no plan at all, so there is nothing for a caller to launch by mistake.
    should(outcome.kind).equal('unservable-model');
    should(outcome.kind === 'unservable-model' && outcome.requested).equal('forge');
    should(outcome.kind === 'unservable-model' && outcome.reason).match(
      /account agent-primary does not serve model "forge"/u,
    );
  });
});

describe('SessionPlanner, on an account whose catalog declares a window', () => {
  const catalogued = account({
    id: 'account-default',
    agent: 'claude-default',
    displayName: 'Default',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', available: true, context: EXTENDED_CONTEXT_WINDOW },
      { id: 'claude-sonnet-5', available: true, context: DEFAULT_CONTEXT_WINDOW },
      { id: 'no-catalog', available: true },
    ],
  });

  it('should plan the window the catalog declares, not the 200k default a bare id would read as', () => {
    // Arrange / Act — the owner's refusal: claude-opus-5-5 is a 1M model, and its id carries no selector.
    const plan = planFor(new SessionPlanner(policy()), { id: 's', account: catalogued, mode: 'interactive' });
    const sonnet = planFor(new SessionPlanner(policy()), {
      id: 's',
      account: catalogued,
      mode: 'interactive',
      requestedModel: 'claude-sonnet-5',
    });
    const unlisted = planFor(new SessionPlanner(policy()), {
      id: 's',
      account: catalogued,
      mode: 'interactive',
      requestedModel: 'no-catalog',
    });

    // Assert
    should(plan.contextWindow).equal(EXTENDED_CONTEXT_WINDOW);
    should(sonnet.contextWindow).equal(DEFAULT_CONTEXT_WINDOW);
    should(unlisted.contextWindow).equal(DEFAULT_CONTEXT_WINDOW);
  });

  it('should keep a [1m] selector on the model it plans, instead of refusing it as unserved', () => {
    // Arrange / Act — a session records `claude-opus-5-5[1m]`; the account lists `claude-opus-5-5`.
    // Matching the id literally made a Restart fall back to the default id, drop the selector and
    // plan the default window for a conversation running in a million tokens.
    const plan = planFor(new SessionPlanner(policy()), {
      id: 's',
      account: catalogued,
      mode: 'interactive',
      requestedModel: 'claude-opus-5-5[1m]',
    });

    // Assert
    should(plan.model).equal('claude-opus-5-5[1m]');
    should(plan.contextWindow).equal(EXTENDED_CONTEXT_WINDOW);
  });
});
