import { describe, it } from 'bun:test';
import { MAX_ASK_DETAIL_LENGTH } from '@ferretry/core-asks/contract';
import should from 'should';
import { WorkflowSchema } from '../../../contract/index.ts';
import {
  acceptedProposal,
  LANE_CHANGE_LATER,
  LANE_CHANGE_READ_FIRST,
  LANE_PROPOSAL_ANSWERS,
  LANE_PROPOSAL_SOURCE,
  LANE_TEMPLATES,
  type LaneProposalAnswer,
  LaneProposalAcceptance,
  type LaneSet,
  laneChangeCard,
  laneGateProblems,
  laneProposalCard,
  laneProposalReference,
  type PendingLaneSet,
} from '../../../daemon/lib/lanes/index.ts';
import { FERRETRY_ID } from './support.ts';

const LANES: LaneSet = {
  projectId: FERRETRY_ID,
  version: 2,
  confirmedBy: null,
  proposedBy: 'koen',
  ...LANE_TEMPLATES.quick,
};

/** An answered ask; by default the lane producer's own (Asks' `daemon` source), the owner choosing Accept. */
const answer = (
  entry: string | null,
  choice: string | undefined = ' Accept ',
  source: string = LANE_PROPOSAL_SOURCE,
): LaneProposalAnswer => ({
  source,
  entry: entry ?? '',
  effect: 'choose',
  ...(choice === undefined ? {} : { choice }),
});

describe('laneProposalReference and laneProposalCard', () => {
  it('should key the card by project and version', () => {
    should(laneProposalReference(FERRETRY_ID, 2)).equal(`lanes:${FERRETRY_ID}:2`);
  });

  it('should offer Accept and Edit with the lane path as its subject', () => {
    const card = laneProposalCard('Ferretry', LANES);

    should(card.subject).equal('Lanes for Ferretry: Todo → Doing → Ready to try → Closed');
    should(card.title).equal('Lanes for Ferretry');
    should(card.kind).equal('choice');
    // → is yes: Accept on the right, Edit on the left.
    should(card.options.map(option => option.label)).deepEqual([
      LANE_PROPOSAL_ANSWERS.edit,
      LANE_PROPOSAL_ANSWERS.accept,
    ]);
    should(card.why).containEql('koen proposed');
  });
});

describe('laneChangeCard', () => {
  const live: LaneSet = { ...LANES, ...LANE_TEMPLATES['pr-release-verify'], confirmedBy: 'owner' };
  /** Plan/Design made automatic, and Released · to test gone with its cards closed. */
  const risky: PendingLaneSet = {
    version: 3,
    baseVersion: 2,
    proposedBy: 'koen',
    ...LANE_TEMPLATES['pr-release-verify'],
    lanes: LANE_TEMPLATES['pr-release-verify'].lanes
      .filter(lane => lane.id !== 'released')
      .map(lane =>
        lane.id === 'plan'
          ? { ...lane, ownerGate: false, stage: { kind: 'auto' as const, triggers: ['work.started' as const] } }
          : lane,
      ),
    variants: Object.fromEntries(
      Object.entries(LANE_TEMPLATES['pr-release-verify'].variants).map(([workflow, ids]) => [
        workflow,
        (ids ?? []).filter(id => id !== 'released'),
      ]),
    ),
    relocate: { released: 'closed' },
  };

  it('should say the board keeps its lanes until the owner accepts, and what the change would do', () => {
    const card = laneChangeCard('Ferretry', live, risky);

    should(card.subject).equal('Lanes for Ferretry: Todo → Plan/Design → In progress → Merged → Closed');
    // One line of intro, then one bullet per thing to decide.
    should(card.why).equal(
      [
        'koen proposes new lanes for Ferretry. The board keeps its lanes until you accept. Accepting it:',
        '',
        '- makes Plan/Design automatic: it would stop waiting for the owner',
        '- removes Released, which waits for the owner, and sends its cards into the closed lane, which closes them',
      ].join('\n'),
    );
    // Accept → stays plain; Edit ← is recommended, so it is the highlighted one.
    should(card.options.map(option => option.label)).deepEqual([
      LANE_PROPOSAL_ANSWERS.edit,
      LANE_PROPOSAL_ANSWERS.accept,
    ]);
    should(card.recommendation).deepEqual({ decision: LANE_PROPOSAL_ANSWERS.edit, why: LANE_CHANGE_READ_FIRST });
  });

  it('should tell lanes removed the same way as one bullet', () => {
    // Arrange: fourteen gates removed with their cards closed.
    const gates = Array.from({ length: 14 }, (_, index) => ({
      id: `gate-${String(index)}`,
      name: `Owner review ${String(index).padStart(2, '0')}`,
      category: 'active' as const,
      ownerGate: true,
    }));
    const todo = { id: 'todo', name: 'Todo', category: 'backlog' as const };
    const closed = { id: 'closed', name: 'Closed', category: 'closed' as const, ownerGate: true };
    const crowded: LaneSet = { ...live, lanes: [todo, ...gates, closed], variants: {} };
    const emptied: PendingLaneSet = {
      ...risky,
      lanes: [todo, closed],
      variants: {},
      relocate: Object.fromEntries(gates.map(gate => [gate.id, 'closed'])),
    };

    // Act + Assert
    should(laneChangeCard('Ferretry', crowded, emptied).why).endWith(
      '\n\n- removes 14 lanes that wait for the owner (Owner review 00 … Owner review 13), and sends their cards into the closed lane, which closes them',
    );
  });

  it('should never cut a warning short: the ones that do not fit are counted, and the card has no Accept', () => {
    // Arrange: fourteen long-named gates, each made automatic and skipped by every workflow — no two alike.
    const name = (index: number) => `Owner review stage number ${String(index).padStart(2, '0')} of the many`;
    const gates = Array.from({ length: 14 }, (_, index) => ({
      id: `gate-${String(index)}`,
      name: name(index),
      category: 'active' as const,
      ownerGate: true,
    }));
    const todo = { id: 'todo', name: 'Todo', category: 'backlog' as const };
    const closed = { id: 'closed', name: 'Closed', category: 'closed' as const, ownerGate: true };
    const every = (ids: readonly string[]) =>
      Object.fromEntries(WorkflowSchema.options.map(workflow => [workflow, [...ids]]));
    const all = ['todo', ...gates.map(gate => gate.id), 'closed'];
    const crowded: LaneSet = { ...live, lanes: [todo, ...gates, closed], variants: every(all) };
    const disarmed: PendingLaneSet = {
      ...risky,
      lanes: [todo, ...gates.map(gate => ({ ...gate, ownerGate: false })), closed],
      variants: every(['todo', 'closed']),
      relocate: {},
    };

    // Act
    const card = laneChangeCard('Ferretry', crowded, disarmed);

    // Assert
    should(card.why.length).be.belowOrEqual(MAX_ASK_DETAIL_LENGTH);
    should(card.why).match(/\n- and \d+ more, all in the Board lane editor$/u);
    should(card.why).containEql(`- makes ${name(0)} automatic: it would stop waiting for the owner\n`);
    should(
      card.why
        .split('\n\n')[1]
        ?.split('\n')
        .every(line => line.startsWith('- ')),
    ).be.true();
    should(card.recommendation).be.undefined();
    // A change the card cannot show in full is accepted only in the lane editor.
    should(card.options).deepEqual([
      { label: LANE_CHANGE_LATER, description: 'Leave it waiting; the board keeps its lanes' },
      {
        label: LANE_PROPOSAL_ANSWERS.edit,
        description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
      },
    ]);
    should(card.options.map(option => option.label)).not.containEql(LANE_PROPOSAL_ANSWERS.accept);
    should(card.howToResolve).containEql('accepted in the Board lane editor');
  });

  it('should cap a long proposer name so it never crowds out the warnings', () => {
    const card = laneChangeCard('Ferretry', live, { ...risky, proposedBy: 'x'.repeat(500) });

    should(card.why).containEql('\n- makes Plan/Design automatic');
    should(card.why.startsWith('x'.repeat(61))).be.false();
  });

  it('should warn of nothing for a change that only renames', () => {
    const renamed: PendingLaneSet = {
      ...risky,
      ...LANE_TEMPLATES['pr-release-verify'],
      lanes: LANE_TEMPLATES['pr-release-verify'].lanes.map(lane => ({ ...lane, name: `${lane.name}!` })),
      relocate: {},
    };

    should(laneGateProblems(live, renamed, renamed.relocate)).deepEqual([]);
    const card = laneChangeCard('Ferretry', live, renamed);
    should(card.why).not.containEql('Accepting it');
    should(card).not.have.property('recommendation');
    should(card.options.map(option => option.label)).deepEqual([
      LANE_PROPOSAL_ANSWERS.edit,
      LANE_PROPOSAL_ANSWERS.accept,
    ]);
  });
});

describe('acceptedProposal', () => {
  it('should read the project and version out of an accepted ask', () => {
    should(acceptedProposal(answer(laneProposalReference(FERRETRY_ID, 3)))).deepEqual({
      projectId: FERRETRY_ID,
      version: 3,
    });
  });

  it('should ignore everything that confirms nothing', () => {
    const reference = laneProposalReference(FERRETRY_ID, 3);
    should(acceptedProposal(answer(null))).be.undefined();
    should(acceptedProposal(answer('task:F1'))).be.undefined();
    should(acceptedProposal({ source: LANE_PROPOSAL_SOURCE, entry: reference, effect: 'choose' })).be.undefined();
    should(acceptedProposal({ source: LANE_PROPOSAL_SOURCE, entry: reference, effect: 'dismiss' })).be.undefined();
    should(acceptedProposal(answer(reference, 'Edit'))).be.undefined();
  });

  it('should ignore a reference that does not parse', () => {
    should(acceptedProposal(answer(`lanes:${FERRETRY_ID}:x`))).be.undefined();
    should(acceptedProposal(answer(`lanes:${FERRETRY_ID}:0`))).be.undefined();
    should(acceptedProposal(answer('lanes::2'))).be.undefined();
    should(acceptedProposal(answer('lanes:not-a-project:2'))).be.undefined();
  });
});

describe('acceptedProposal binds to the lane producer', () => {
  it('never reads an Accept on an ask any other source raised under a lanes: entry', () => {
    const reference = laneProposalReference(FERRETRY_ID, 2);
    should(acceptedProposal(answer(reference, ' Accept ', 'question'))).be.undefined();
    should(acceptedProposal(answer(reference, ' Accept ', 'ferret'))).be.undefined();
    should(acceptedProposal(answer(reference))).deepEqual({ projectId: FERRETRY_ID, version: 2 });
  });
});

describe('LaneProposalAcceptance', () => {
  it('should confirm the proposal when the owner accepts', async () => {
    const accepted: Array<readonly [string, number]> = [];
    const subject = new LaneProposalAcceptance({
      acceptProposal: async (projectId, version) => {
        accepted.push([projectId, version]);
        return true;
      },
    });

    await subject.answered(answer(laneProposalReference(FERRETRY_ID, 2)));

    should(accepted).deepEqual([[FERRETRY_ID, 2]]);
  });

  it('should do nothing for other answers and other asks', async () => {
    let calls = 0;
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        calls += 1;
        return true;
      },
    });

    await subject.answered({
      source: LANE_PROPOSAL_SOURCE,
      entry: laneProposalReference(FERRETRY_ID, 2),
      effect: 'dismiss',
    });
    await subject.answered(answer(null));
    await subject.answered(answer('task:F1'));
    await subject.answered(answer(laneProposalReference(FERRETRY_ID, 2), 'Accept', 'ferret'));

    should(calls).equal(0);
  });

  it('should stay total when the store fails', async () => {
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        throw new Error('disk full');
      },
    });

    await subject.answered(answer(laneProposalReference(FERRETRY_ID, 2)));
  });
});
