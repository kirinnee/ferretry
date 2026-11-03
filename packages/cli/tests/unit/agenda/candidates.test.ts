import { describe, it } from 'bun:test';
import type { AgendaActionRequest, AgendaItem } from '@ferretry/protocol';
import should from 'should';
import {
  agendaCandidates,
  candidateState,
  isAgendaCandidate,
  joinCommand,
  MAX_LISTED_CANDIDATES,
  points,
  renderCandidates,
  sharedWords,
} from '../../../src/lib/agenda/candidates';
import { agentItem, humanItem, SESSION } from './fixtures';

const request: Extract<AgendaActionRequest, { action: 'add' }> = {
  action: 'add',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Pick the relay region',
  why: 'Pick the relay region',
  howToResolve: 'answer on the board',
  title: 'Relay region',
  premise: '- The relay goes live',
  context: '- Two regions are near',
};

const query = { sessionId: SESSION, title: 'Relay region', ask: 'Pick the relay region' };

describe('agenda candidates', () => {
  it('should take only what a ferret can add to', () => {
    should(isAgendaCandidate(agentItem('A1', 'pick a relay'))).be.true();
    should(isAgendaCandidate(humanItem('A2', 'the owner asked'))).be.false();
    should(isAgendaCandidate(agentItem('A3', 'a notice', { notice: true }))).be.false();
    should(isAgendaCandidate({ ...agentItem('A4', 'a form'), input: { requestId: 'r1' } } as AgendaItem)).be.false();
  });

  it('should read the owner-facing state: Needs you, Resting or Snoozed', () => {
    const item = agentItem('A1', 'pick a relay');
    should(candidateState(item)).equal('needs you');
    should(candidateState({ ...item, waitingOn: 'ferret' })).equal('resting');
    should(candidateState({ ...item, parked: { reason: 'replied', at: '2026-07-31T09:00:00.000Z' } })).equal('resting');
    should(
      candidateState({
        ...item,
        parked: { reason: 'snoozed', at: '2026-07-31T09:00:00.000Z', until: '2026-07-31T12:00:00.000Z' },
      }),
    ).equal('snoozed');
  });

  it('should count the meaningful words two texts share', () => {
    should(sharedWords('Pick the relay region', 'Which relay region?')).equal(2);
    should(sharedWords('Pick the relay', 'Token saving')).equal(0);
  });

  it('should list the closest first: a tied card, then the daemon’s match, then shared words, then the oldest', () => {
    // Arrange
    const items = [
      agentItem('A1', 'token saving', { waitingSince: '2026-07-30T09:00:00.000Z' }),
      agentItem('A2', 'relay region pick'),
      agentItem('A3', 'logo colours'),
      { ...agentItem('A4', 'cache warmup'), task: { id: 'F9' } } as AgendaItem,
    ];

    // Act
    const plain = agendaCandidates(items, query).map(each => each.id);
    const matched = agendaCandidates(items, {
      ...query,
      related: { matches: [{ strength: 'strong', hit: hit('A3') }] },
    }).map(each => each.id);
    const tied = agendaCandidates(items, {
      ...query,
      ties: { card: { id: 'F12' }, dependsOn: [{ id: 'F9' }], blocks: [] },
    });

    // Assert
    should(plain).eql(['A2', 'A1', 'A3', 'A4']);
    should(matched[0]).equal('A3');
    should(tied[0]?.id).equal('A4');
    should(tied[0]?.tie).eql({ kind: 'depends on', card: '&F9' });
    should(tied[0]?.cards).eql(['&F9']);
  });

  it('should ignore a related match in another ferret’s agenda', () => {
    // Act
    const ranked = agendaCandidates([agentItem('A1', 'token saving'), agentItem('A3', 'logo colours')], {
      ...query,
      related: { matches: [{ strength: 'strong', hit: { ...hit('A3'), sessionId: 'someone-else' } }] },
    });

    // Assert
    should(ranked.map(each => each.id)).eql(['A1', 'A3']);
  });

  it('should tie the same card, and a card that depends on the named one', () => {
    const same = { ...agentItem('A1', 'x'), task: { id: 'F12' } } as AgendaItem;
    const blocks = { ...agentItem('A2', 'y'), task: { id: 'F14' } } as AgendaItem;
    const ranked = agendaCandidates([blocks, same], {
      ...query,
      ties: { card: { id: 'F12' }, dependsOn: [], blocks: [{ id: 'F14' }] },
    });
    should(ranked.map(each => [each.id, each.tie?.kind])).eql([
      ['A1', 'same card'],
      ['A2', 'blocks'],
    ]);
  });

  it('should add the ask to what is still open, keeping what was there', () => {
    // Arrange
    const [candidate] = agendaCandidates([agentItem('A2', 'relay', { stillOpen: '- Which size' })], query);

    // Act + Assert
    should(candidate && joinCommand('fy', candidate, request)).equal(
      "fy agenda edit A2 --still-open 'Which size' --still-open 'Pick the relay region'",
    );
  });

  it('should bring a Resting item back whole after the owner replied', () => {
    // Arrange
    const replied = {
      ...agentItem('A2', 'relay', { premise: '- Old premise', context: '- The relay goes live' }),
      parked: { reason: 'replied' as const, at: '2026-07-31T09:00:00.000Z' },
    };
    const [candidate] = agendaCandidates([replied], query);

    // Act + Assert
    should(candidate && joinCommand('fy', candidate, request)).equal(
      "fy agenda edit A2 --still-open 'Pick the relay region' --back --summary 'Pick the relay region' --premise 'Old premise' --premise 'The relay goes live' --context 'The relay goes live' --context 'Two regions are near'",
    );
  });

  it('should read bulleted points back as plain lines', () => {
    should(points('- one\n- two\n\n* three')).eql(['one', 'two', 'three']);
    should(points(null)).eql([]);
  });

  it('should render the listing: the rows, the join question with its edit, and the new-agenda way out', () => {
    // Arrange
    const many = Array.from({ length: MAX_LISTED_CANDIDATES + 2 }, (_, at) =>
      agentItem(`A${String(at + 1)}` as AgendaItem['id'], `topic ${String(at + 1)}`),
    );

    // Act
    const text = renderCandidates(agendaCandidates(many, query), { binary: 'zz', request });

    // Assert
    should(text).startWith(
      'Search, check, then open: these agendas are open, closest first.\n  !A1  needs you  topic 1',
    );
    should(text).containEql('… and 2 more: zz agenda ls');
    should(text).containEql('Should this join !A1? It does when all three hold: same place, same context, same pace;');
    should(text).containEql("zz agenda edit A1 --still-open 'Pick the relay region'");
    should(text).endWith(
      'Open a new agenda only when none passes the test:\n  zz agenda add … --new "<why none fits>"',
    );
  });
});

function hit(id: AgendaItem['id']) {
  return {
    kind: 'agenda' as const,
    id,
    sessionId: SESSION,
    title: 'x',
    state: 'open' as const,
    standing: 'open',
    updatedAt: '2026-07-31T09:00:00.000Z',
    match: { field: 'title' as const, line: 'x' },
    score: 1,
  };
}
