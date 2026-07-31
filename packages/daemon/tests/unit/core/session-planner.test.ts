import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_CONTEXT_WINDOW,
  EXTENDED_CONTEXT_WINDOW,
  SessionPlanner,
  defaultStartWaitPolicy,
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
    const plan = new SessionPlanner(policy()).plan({ id: 'ab/cd', account: claude, mode: 'auto' });

    // Assert
    should(plan.tmuxName).equal('fyd-ab-cd-agent-primary');
  });

  it('should title the harness window with the teammate and the task', () => {
    // Arrange / Act
    const plan = new SessionPlanner(policy()).plan({
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
    const plan = new SessionPlanner(policy()).plan({
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
    const plan = new SessionPlanner(policy()).plan({
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
    const plan = new SessionPlanner(policy()).plan({ id: 'session-1', account: claude, mode: 'auto' });

    // Assert
    should(plan.model).equal('apex');
    should(plan.modelSource).equal('account-default');
  });

  it('should size the context window from the model the session will really run', () => {
    // Arrange / Act
    const plan = new SessionPlanner(policy()).plan({
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
    const plan = new SessionPlanner(policy({ contextWindowOverrides: { apex: 300_000 } })).plan({
      id: 'session-1',
      account: claude,
      mode: 'auto',
    });

    // Assert
    should(plan.contextWindow).equal(300_000);
  });

  it('should believe a window the harness reports about itself', () => {
    // Arrange / Act
    const plan = new SessionPlanner(policy({ contextWindowOverrides: { apex: 300_000 } })).plan({
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
    const plan = new SessionPlanner(policy()).plan({ id: 'session-1', account: claude, mode: 'auto' });

    // Assert
    should(plan.contextWindow).equal(DEFAULT_CONTEXT_WINDOW);
  });

  it('should hold the launch open for the policy window', () => {
    // Arrange
    const slow = policy({ startWait: { ...defaultStartWaitPolicy, slowAccountIds: ['account-primary'] } });

    // Act / Assert
    should(new SessionPlanner(slow).plan({ id: 's', account: claude, mode: 'auto' }).startWaitMs).equal(90_000);
    should(new SessionPlanner(policy()).plan({ id: 's', account: claude, mode: 'auto' }).startWaitMs).equal(45_000);
  });

  it('should label the remote-control surface with the teammate it belongs to', () => {
    // Arrange / Act
    const plan = new SessionPlanner(policy()).plan({
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
    const plan = new SessionPlanner(policy()).plan({ id: 'session-1', account: codex, mode: 'auto' });

    // Assert
    should(plan.extraArgs).eql([]);
  });

  it('should measure consumption against the window it assigned, not a guessed one', () => {
    // Arrange
    const planner = new SessionPlanner(policy());
    const plan = planner.plan({ id: 'session-1', account: claude, mode: 'auto', requestedModel: 'apex[1m]' });

    // Act / Assert — 100k of a 1M window is 10%, not the 50% a default-sized window would report
    should(planner.contextUsedPercent(plan, 100_000)).equal(10);
  });
});
