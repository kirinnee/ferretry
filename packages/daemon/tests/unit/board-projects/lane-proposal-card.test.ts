import { describe, it } from 'bun:test';
import { LANE_TEMPLATES, type LaneSet, type ResolvedAgendaItem } from '@ferretry/protocol';
import should from 'should';
import type { AgendaBoardChange } from '../../../src/lib/agenda/service.ts';
import {
  acceptedProposal,
  LANE_PROPOSAL_ANSWERS,
  LaneProposalAcceptance,
  laneProposalCard,
  laneProposalReference,
} from '../../../src/lib/board-projects/index.ts';
import { FERRETRY_ID } from './support.ts';

const LANES: LaneSet = {
  projectId: FERRETRY_ID,
  version: 2,
  confirmedBy: null,
  proposedBy: 'koen',
  ...LANE_TEMPLATES.quick,
};

const item = (sourceRef: string | null, response?: unknown): ResolvedAgendaItem =>
  ({ sourceRef, ...(response === undefined ? {} : { response }) }) as unknown as ResolvedAgendaItem;

const accept = { kind: 'multiple-choice', choice: ' Accept ' };

describe('laneProposalReference and laneProposalCard', () => {
  it('should key the card by project and version', () => {
    should(laneProposalReference(FERRETRY_ID, 2)).equal(`lanes:${FERRETRY_ID}:2`);
  });

  it('should offer Accept and Edit with the lane path as its subject', () => {
    const card = laneProposalCard('Ferretry', LANES);

    should(card.subject).equal('Lanes for Ferretry: Todo → Doing → Closed');
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

describe('LaneProposalAcceptance', () => {
  const change = (overrides: Partial<AgendaBoardChange>): AgendaBoardChange =>
    ({ change: 'answered', ...overrides }) as AgendaBoardChange;

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

  it('should stay total when the store fails', async () => {
    const subject = new LaneProposalAcceptance({
      acceptProposal: async () => {
        throw new Error('disk full');
      },
    });

    await subject.changed('s1', change({ addressed: item(laneProposalReference(FERRETRY_ID, 2), accept) }));
  });
});
