import { describe, it } from 'bun:test';
import type { PhoneApprovalAgentView, PhoneApprovalRaise } from '@ferretry/protocol';
import should from 'should';
import type { AgentPhoneApprovalPort, AgentToolError } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, person } from './support.ts';

const ID = `pa_${'0'.repeat(23)}1`;

/** A phone-approval port that records what it was asked and answers with whatever the case set. */
class FakeApprovals implements AgentPhoneApprovalPort {
  readonly raised: { sessionId: string; agentName: string | undefined; raise: PhoneApprovalRaise }[] = [];
  readonly waited: { sessionId: string; id: string; waitMs: number }[] = [];
  view: PhoneApprovalAgentView = { id: ID, state: 'waiting' };

  async raise(sessionId: string, agentName: string | undefined, raise: PhoneApprovalRaise) {
    this.raised.push({ sessionId, agentName, raise });
    return this.view;
  }

  async agentView(sessionId: string, id: string, waitMs: number) {
    this.waited.push({ sessionId, id, waitMs });
    return this.view;
  }
}

const refusal = async (work: Promise<unknown>): Promise<AgentToolError> =>
  (await work.then(
    () => undefined,
    (failure: unknown) => failure,
  )) as AgentToolError;

describe('AgentToolService — push: true on a request tool', () => {
  it('should raise a phone approval on the page, handing on where to look and the hints only', async () => {
    // Arrange
    const phoneApprovals = new FakeApprovals();
    const world = agentToolWorld({ phoneApprovals });
    await world.service.call(agent, { tool: 'browser.open', name: 'app' });

    // Act
    const asked = await world.service.call(agent, {
      tool: 'browser.request_input',
      name: 'app',
      push: true,
      ref: 'e12',
      secretHint: 'CLICKUP',
      waitSeconds: 60,
    });

    // Assert
    should(phoneApprovals.raised).deepEqual([
      {
        sessionId: 's1',
        agentName: 'Hadi',
        raise: {
          target: { kind: 'browser', key: 'app' },
          element: { kind: 'ref', ref: 'e12' },
          secretHint: 'CLICKUP',
          waitSeconds: 60,
        },
      },
    ]);
    should(asked.phoneApproval).deepEqual({ id: ID, state: 'waiting' });
    should(asked.summary).match(/never tell the owner a number/u);
  });

  it('should raise one on a terminal with the default wait', async () => {
    // Arrange
    const phoneApprovals = new FakeApprovals();
    const world = agentToolWorld({ phoneApprovals });
    await world.service.call(agent, { tool: 'terminal.open', name: 'aws' });

    // Act
    await world.service.call(agent, { tool: 'terminal.request_input', name: 'aws', push: true });

    // Assert
    should(phoneApprovals.raised[0]?.raise).deepEqual({ target: { kind: 'terminal', key: 'aws' }, waitSeconds: 120 });
  });

  it('should wait on a pa_ id and say where it stands, never a number', async () => {
    // Arrange
    const phoneApprovals = new FakeApprovals();
    phoneApprovals.view = { id: ID, state: 'moved-on', secondFactor: 'push' };
    const world = agentToolWorld({ phoneApprovals });

    // Act
    const waited = await world.service.call(agent, { tool: 'input.wait', id: ID, timeoutMs: 5_000 });

    // Assert
    should(phoneApprovals.waited).deepEqual([{ sessionId: 's1', id: ID, waitMs: 5_000 }]);
    should(waited.phoneApproval).deepEqual({ id: ID, state: 'moved-on', secondFactor: 'push' });
    should(waited).not.have.property('input');
    should(waited.summary).match(/went through after a push/u);
  });

  it('should leave raising and waiting on one to an agent', async () => {
    // Arrange
    const world = agentToolWorld({ phoneApprovals: new FakeApprovals() });
    await world.service.call(person, { tool: 'terminal.open', name: 'aws' });

    // Act
    const raised = await refusal(
      world.service.call(person, { tool: 'terminal.request_input', name: 'aws', push: true }),
    );
    const waited = await refusal(world.service.call(person, { tool: 'input.wait', id: ID }));

    // Assert
    should(raised.code).equal('bad_request');
    should(waited.code).equal('bad_request');
  });

  it('should refuse push where no phone approvals are wired', async () => {
    // Arrange
    const world = agentToolWorld();
    await world.service.call(agent, { tool: 'terminal.open', name: 'aws' });

    // Act
    const refused = await refusal(
      world.service.call(agent, { tool: 'terminal.request_input', name: 'aws', push: true }),
    );

    // Assert
    should(refused.code).equal('unavailable');
  });
});

describe('AgentToolService — what input.wait says of a phone approval', () => {
  it('should say each state in words the ferret can act on, and never a number', async () => {
    // Arrange
    const phoneApprovals = new FakeApprovals();
    const world = agentToolWorld({ phoneApprovals });
    const states: PhoneApprovalAgentView[] = [
      { id: ID, state: 'waiting' },
      { id: ID, state: 'moved-on' },
      { id: ID, state: 'timed-out' },
      { id: ID, state: 'refused' },
      { id: ID, state: 'gone' },
    ];

    // Act
    const summaries: string[] = [];
    for (const view of states) {
      phoneApprovals.view = view;
      summaries.push((await world.service.call(agent, { tool: 'input.wait', id: ID })).summary);
    }

    // Assert
    should(summaries[0]).match(/still waiting/u);
    should(summaries[1]).match(/moved on/u);
    should(summaries[1]).not.match(/push/u);
    should(summaries[2]).match(/ran out of time/u);
    should(summaries[3]).match(/Stop signing in there/u);
    should(summaries[4]).match(/closed/u);
  });
});
