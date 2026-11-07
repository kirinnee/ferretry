import { describe, it } from 'bun:test';
import type { AgendaItem } from '../../../../daemon/lib/protocol/agenda.ts';
import type { WorkHit, WorkRelatedResponse } from '@ferretry/protocol';
import should from 'should';
import { closestAgenda, closestAgendaLink } from '../../../../daemon/lib/agenda/closest.ts';

const SESSION = 'mvzyotb7-7613fdae';

const item = (id: AgendaItem['id'], overrides: Record<string, unknown> = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `the ask of ${id}`,
    title: `Topic ${id}`,
    why: 'w',
    howToResolve: 'h',
    waitingSince: '2026-11-03T09:00:00.000Z',
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'sol',
    ...overrides,
  }) as AgendaItem;

const hit = (id: AgendaItem['id'], sessionId = SESSION): WorkHit => ({
  kind: 'agenda',
  id,
  sessionId,
  title: `Topic ${id}`,
  state: 'open',
  standing: 'open',
  updatedAt: '2026-11-03T09:00:00.000Z',
  match: { field: 'title', line: `Topic ${id}` },
  score: 3,
});

const related = (...matches: WorkRelatedResponse['matches']): WorkRelatedResponse => ({ matches });

describe('closestAgenda', () => {
  it("should pick the daemon's first strong match among the session's open topics", () => {
    // Act
    const closest = closestAgenda(
      related(
        { strength: 'weak', hit: hit('A1') },
        { strength: 'strong', hit: hit('A2') },
        { strength: 'strong', hit: hit('A3') },
      ),
      SESSION,
      [item('A1'), item('A2'), item('A3')],
    );

    // Assert
    should(closest).eql({ id: 'A2', title: 'Topic A2' });
  });

  it('should name none for a weak match, another session, a closed item or one that is no topic', () => {
    should(closestAgenda(related({ strength: 'weak', hit: hit('A1') }), SESSION, [item('A1')])).be.undefined();
    should(
      closestAgenda(related({ strength: 'strong', hit: hit('A1', 'other') }), SESSION, [item('A1')]),
    ).be.undefined();
    should(closestAgenda(related({ strength: 'strong', hit: hit('A9') }), SESSION, [item('A1')])).be.undefined();
    for (const notTopic of [
      item('A1', { notice: true }),
      item('A1', { input: { requestId: 'r' } }),
      item('A1', { raisedBy: 'human', raisedBySession: null, raisedByName: null }),
    ]) {
      should(closestAgenda(related({ strength: 'strong', hit: hit('A1') }), SESSION, [notTopic])).be.undefined();
    }
  });

  it('should link it as "Part of: <title>", clipped to a label, targeting the reference', () => {
    should(closestAgendaLink({ id: 'A3', title: 'Deploy the relay' })).eql({
      label: 'Part of: Deploy the relay',
      target: '!A3',
      meaning: 'The open agenda this belongs with: the same topic, so the answer lands in one place.',
    });
    should(closestAgendaLink({ id: 'A3', title: 'x'.repeat(200) }).label).have.length(120);
  });
});
