import { describe, it } from 'bun:test';
import { LANE_TEMPLATES, type LaneSet, laneProposalReference } from '@ferretry/protocol';
import should from 'should';
import { type AgendaRaiser, AgendaLaneAgenda } from '../../../src/adapters/board-projects/agenda-lane-agenda.ts';
import { laneProposalCard } from '../../../src/lib/board-projects/index.ts';

const laneSet: LaneSet = {
  projectId: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as LaneSet['projectId'],
  version: 1,
  confirmedBy: null,
  proposedBy: 'denisha',
  ...LANE_TEMPLATES.quick,
};

describe('the lane agenda adapter', () => {
  it('should raise a daemon-sourced task choice under the stable reference', async () => {
    const raised: unknown[] = [];
    const raiser = {
      raise: (...args: unknown[]) => {
        raised.push(args);
        return Promise.resolve({ ok: true });
      },
    } as unknown as AgendaRaiser;
    const card = laneProposalCard('Ferretry', laneSet);
    await new AgendaLaneAgenda(raiser).raise('session-1', laneProposalReference(laneSet.projectId, 1), card);
    const [sessionId, request, actor] = raised[0] as [string, Record<string, unknown>, unknown];
    should(sessionId).equal('session-1');
    should(request).containEql({
      source: 'task',
      sourceRef: laneProposalReference(laneSet.projectId, 1),
      title: card.title,
    });
    should(actor).eql({ kind: 'daemon', cause: 'system' });
  });

  it('should throw with the agenda’s reason when it refuses', async () => {
    const raiser = {
      raise: () => Promise.resolve({ ok: false, error: { message: 'agenda is full' } }),
    } as unknown as AgendaRaiser;
    await new AgendaLaneAgenda(raiser).raise('session-1', 'lanes:x:1', laneProposalCard('Ferretry', laneSet)).then(
      () => should.fail('expected a refusal', 'a refusal'),
      (error: Error) => should(error.message).match(/agenda is full/u),
    );
  });
});
