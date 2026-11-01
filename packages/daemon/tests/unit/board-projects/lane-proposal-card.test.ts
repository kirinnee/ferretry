import { describe, it } from 'bun:test';
import {
  LANE_PROPOSAL_ANSWERS,
  LANE_TEMPLATES,
  type LaneSet,
  laneGateProblems,
  MAX_AGENDA_DETAIL_LENGTH,
  laneProposalReference,
  type PendingLaneSet,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import { AgendaService, type AgendaLedger } from '../../../src/lib/agenda/index.ts';
import { harnessQuestionRequest } from '../../../src/lib/agenda/harness-prompt.ts';
import type { AgendaBoardChange } from '../../../src/lib/agenda/service.ts';
import {
  acceptedProposal,
  LaneProposalAcceptance,
  LANE_CHANGE_LATER,
  laneChangeCard,
  laneProposalCard,
} from '../../../src/lib/board-projects/index.ts';
import { FERRETRY_ID } from './support.ts';

const LANES: LaneSet = {
  projectId: FERRETRY_ID,
  version: 2,
  confirmedBy: null,
  proposedBy: 'koen',
  ...LANE_TEMPLATES.quick,
};

/** A closed item; by default the lane producer's own card (the daemon's, under source `task`). */
const item = (
  sourceRef: string | null,
  response?: unknown,
  producer: { readonly raisedBy: string; readonly source: string } = { raisedBy: 'daemon', source: 'task' },
): ResolvedAgendaItem =>
  ({ sourceRef, ...producer, ...(response === undefined ? {} : { response }) }) as unknown as ResolvedAgendaItem;

const accept = { kind: 'multiple-choice', choice: ' Accept ' };

describe('laneProposalReference and laneProposalCard', () => {
  it('should key the card by project and version', () => {
    should(laneProposalReference(FERRETRY_ID, 2)).equal(`lanes:${FERRETRY_ID}:2`);
  });

  it('should offer Accept and Edit with the lane path as its subject', () => {
    const card = laneProposalCard('Ferretry', LANES);

    should(card.subject).equal('Lanes for Ferretry: Todo → Doing → To test → Closed');
    should(card.title).equal('Lanes for Ferretry');
    should(card.kind).equal('choice');
    should(card.ask.kind).equal('multiple-choice');
    should(card.answers.map(answer => answer.label)).deepEqual([
      LANE_PROPOSAL_ANSWERS.accept,
      LANE_PROPOSAL_ANSWERS.edit,
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
    should(card.why).containEql('koen proposes new lanes for Ferretry');
    should(card.why).containEql('keeps its lanes until you accept');
    should(card.why).containEql('Accepting it makes Plan/Design automatic: it would stop waiting for the owner');
    should(card.why).containEql(
      'removes Released · to test, which waits for the owner, and sends its cards into the closed lane, which closes them',
    );
    should(card.why).not.containEql('live already');
    should(card.why).not.containEql('more, all in the Board lane editor');
    should(card.answers.map(answer => answer.label)).deepEqual([
      LANE_PROPOSAL_ANSWERS.accept,
      LANE_PROPOSAL_ANSWERS.edit,
    ]);
  });

  it('should never cut a warning short: the ones that do not fit are counted and pointed at', () => {
    // Arrange: fourteen long-named gates, every one removed with its cards closed — far more than a card holds.
    const name = (index: number) => `Owner review stage number ${String(index).padStart(2, '0')} of the many`;
    const gates = Array.from({ length: 14 }, (_, index) => ({
      id: `gate-${String(index)}`,
      name: name(index),
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

    // Act
    const card = laneChangeCard('The project with the longest name a registry would ever hold', crowded, emptied);

    // Assert
    should(card.why.length).be.belowOrEqual(MAX_AGENDA_DETAIL_LENGTH);
    should(card.why).match(/; and \d+ more, all in the Board lane editor\.$/u);
    should(card.why).containEql(
      `removes ${name(0)}, which waits for the owner, and sends its cards into the closed lane`,
    );
    should(card.why).not.match(/closes the cards… |closes th$/u);
    // A change the card cannot show in full is accepted only in the lane editor.
    should(card.ask).deepEqual({
      kind: 'multiple-choice',
      options: [
        { label: LANE_CHANGE_LATER, description: 'Leave it waiting; the board keeps its lanes' },
        {
          label: LANE_PROPOSAL_ANSWERS.edit,
          description: 'Change them in the Board lane editor (Board, then this project, then Lanes)',
        },
      ],
    });
    should(card.answers.map(answer => answer.label)).not.containEql(LANE_PROPOSAL_ANSWERS.accept);
    should(card.howToResolve).containEql('accepted in the Board lane editor');
  });

  it('should cap a long proposer name so it never crowds out the warnings', () => {
    const card = laneChangeCard('Ferretry', live, { ...risky, proposedBy: 'x'.repeat(500) });

    should(card.why).containEql('Accepting it makes Plan/Design automatic');
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
    should(laneChangeCard('Ferretry', live, renamed).why).not.containEql('Accepting it');
  });
});

describe('acceptedProposal', () => {
  it('should read the project and version out of an accepted card', () => {
    should(acceptedProposal(item(laneProposalReference(FERRETRY_ID, 3), accept))).deepEqual({
      projectId: FERRETRY_ID,
      version: 3,
    });
  });

  it('should ignore everything that confirms nothing', () => {
    const reference = laneProposalReference(FERRETRY_ID, 3);
    should(acceptedProposal(item(null, accept))).be.undefined();
    should(acceptedProposal(item('task:F1', accept))).be.undefined();
    should(acceptedProposal(item(reference))).be.undefined();
    should(acceptedProposal(item(reference, { kind: 'text', text: 'Accept' }))).be.undefined();
    should(acceptedProposal(item(reference, { kind: 'multiple-choice', choice: 'Edit' }))).be.undefined();
  });

  it('should ignore a reference that does not parse', () => {
    should(acceptedProposal(item(`lanes:${FERRETRY_ID}:x`, accept))).be.undefined();
    should(acceptedProposal(item(`lanes:${FERRETRY_ID}:0`, accept))).be.undefined();
    should(acceptedProposal(item('lanes::2', accept))).be.undefined();
    should(acceptedProposal(item('lanes:not-a-project:2', accept))).be.undefined();
  });
});

describe('acceptedProposal binds to the lane producer (docs/agenda.md § Reserved sourceRefs)', () => {
  it('never reads an Accept on an item any other producer raised under a lanes: reference', () => {
    const reference = laneProposalReference(FERRETRY_ID, 2);
    // The review's P6: a ferret's own question file, raised by the daemon's harness producer
    should(acceptedProposal(item(reference, accept, { raisedBy: 'daemon', source: 'question' }))).be.undefined();
    should(acceptedProposal(item(reference, accept, { raisedBy: 'agent', source: 'agent-raised' }))).be.undefined();
    should(acceptedProposal(item(reference, accept, { raisedBy: 'agent', source: 'task' }))).be.undefined();
    should(acceptedProposal(item(reference, accept))).deepEqual({ projectId: FERRETRY_ID, version: 2 });
  });

  it('confirms no lanes when the owner answers Accept on a forged question, end to end', async () => {
    // Arrange — the agenda is real; the forged item is what a question file naming a lane proposal would raise
    let ledger: AgendaLedger | null = null;
    const accepted: number[] = [];
    const acceptance = new LaneProposalAcceptance({
      acceptProposal: async (_projectId, version) => {
        accepted.push(version);
        return true;
      },
    });
    const agenda = new AgendaService(
      {
        read: async () => ledger,
        transact: async (_sessionId, apply) => {
          const mutation = apply(ledger);
          if (mutation.ok) ledger = mutation.ledger;
          return mutation;
        },
      },
      { now: () => '2026-11-01T21:00:00.000Z' },
      { has: async () => true },
      { raised: async () => undefined },
      acceptance,
    );
    const forged = harnessQuestionRequest({
      toolUseId: laneProposalReference(FERRETRY_ID, 2),
      questions: [
        {
          question: 'Keep going?',
          header: 'Go',
          options: [{ label: 'Accept' }, { label: 'Edit' }],
          multiSelect: false,
        },
      ],
    } as never);
    const raised = await agenda.raise('s1', forged, { kind: 'daemon', cause: 'harness-prompt' });
    const id = raised.ok && raised.item !== undefined ? raised.item.id : 'A0';

    // Act
    const answered = await agenda.answer('s1', id, { kind: 'multiple-choice', choice: 'Accept' }, { kind: 'human' });

    // Assert
    should(answered.ok).be.true();
    should(accepted).be.empty();
  });
});

describe('LaneProposalAcceptance', () => {
  const change = (overrides: Partial<AgendaBoardChange>): AgendaBoardChange =>
    ({ change: 'answered', actor: { kind: 'human' }, ...overrides }) as AgendaBoardChange;

  it('should confirm the proposal when the owner accepts', async () => {
    const accepted: Array<readonly [string, number]> = [];
    const subject = new LaneProposalAcceptance({
      acceptProposal: async (projectId, version) => {
        accepted.push([projectId, version]);
        return true;
      },
    });

    await subject.changed('s1', change({ addressed: item(laneProposalReference(FERRETRY_ID, 2), accept) }));

    should(accepted).deepEqual([[FERRETRY_ID, 2]]);
  });

  it('should do nothing for other changes, other cards and cards without an addressed item', async () => {
    let calls = 0;
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        calls += 1;
        return true;
      },
    });

    await subject.changed(
      's1',
      change({ change: 'dismissed', addressed: item(laneProposalReference(FERRETRY_ID, 2), accept) }),
    );
    await subject.changed('s1', change({}));
    await subject.changed('s1', change({ addressed: item('task:F1', accept) }));

    should(calls).equal(0);
  });

  it('should never take an Accept a lead or the daemon gave for the owner’s', async () => {
    // Arrange: a lead may answer the daemon's items on its sub-ferret's agenda, and the daemon its own.
    let calls = 0;
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        calls += 1;
        return true;
      },
    });
    const addressed = item(laneProposalReference(FERRETRY_ID, 2), accept);

    // Act
    await subject.changed(
      's1',
      change({ addressed, actor: { kind: 'agent', sessionId: 'lead', name: 'lead', overSubFerret: true } }),
    );
    await subject.changed('s1', change({ addressed, actor: { kind: 'agent', sessionId: 's1', name: 'koen' } }));
    await subject.changed('s1', change({ addressed, actor: { kind: 'daemon', cause: 'system' } }));

    // Assert
    should(calls).equal(0);
  });

  it('should stay total when the store fails', async () => {
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        throw new Error('disk full');
      },
    });

    await subject.changed('s1', change({ addressed: item(laneProposalReference(FERRETRY_ID, 2), accept) }));
  });
});
