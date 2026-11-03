import { describe, it } from 'bun:test';
import type { AgendaActionRequest, AgendaItem } from '@ferretry/protocol';
import should from 'should';
import {
  agendaCandidates,
  candidateState,
  isAgendaCandidate,
  joinAdvice,
  joinPlan,
  MAX_LISTED_CANDIDATES,
  points,
  renderCandidates,
  sharedWords,
  waysOut,
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

  it('should not tie a card that is neither the named one nor related to it', () => {
    // Act
    const [candidate] = agendaCandidates([{ ...agentItem('A1', 'x'), task: { id: 'F77' } } as AgendaItem], {
      ...query,
      ties: { card: { id: 'F12' }, dependsOn: [{ id: 'F9' }], blocks: [{ id: 'F14' }] },
    });

    // Assert
    should(candidate?.tie).be.undefined();
    should(candidate?.cards).eql(['&F77']);
  });

  it('should say in the listing why a card-tied agenda comes first, for each kind of tie', () => {
    // Arrange
    const ties = { card: { id: 'F12' }, dependsOn: [{ id: 'F9' }], blocks: [{ id: 'F14' }] };
    const items = [
      { ...agentItem('A1', 'a'), task: { id: 'F12' } },
      { ...agentItem('A2', 'b'), task: { id: 'F9' } },
      { ...agentItem('A3', 'c'), task: { id: 'F14' } },
    ] as AgendaItem[];

    // Act
    const text = renderCandidates(agendaCandidates(items, { ...query, ties }), {
      binary: 'zz',
      request,
      named: { id: 'F12' },
    });

    // Assert
    should(text).containEql('← carries &F12, the card this one names');
    should(text).containEql('← carries &F9, which &F12 depends on');
    should(text).containEql('← carries &F14, which depends on &F12');
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

  it('should join a plain-words ask by one edit that keeps what was there and adds the ask', () => {
    // Arrange
    const [candidate] = agendaCandidates([agentItem('A2', 'relay', { stillOpen: '- Which size' })], query);

    // Act
    const plan = candidate && joinPlan('fy', candidate, request);

    // Assert
    should(plan).eql({
      kind: 'edit',
      command:
        "fy agenda edit A2 --still-open 'Which size' --still-open 'Pick the relay region' --premise 'The relay goes live' --context 'Two regions are near'",
    });
  });

  it('should bring a Resting item back whole, keeping its old subject in what is still open', () => {
    // Arrange
    const replied = {
      ...agentItem('A2', 'relay', { premise: '- Old premise', context: '- The relay goes live' }),
      parked: { reason: 'replied' as const, at: '2026-07-31T09:00:00.000Z' },
    };
    const [candidate] = agendaCandidates([replied], query);

    // Act
    const plan = candidate && joinPlan('fy', candidate, request);

    // Assert
    should(plan).eql({
      kind: 'edit',
      command:
        "fy agenda edit A2 --still-open 'relay' --still-open 'Pick the relay region' --premise 'Old premise' --premise 'The relay goes live' --context 'The relay goes live' --context 'Two regions are near' --back --summary 'Pick the relay region'",
    });
  });

  it('should carry the new decided points over, and a plain ask on a same-kind question', () => {
    // Arrange
    const [candidate] = agendaCandidates(
      [agentItem('A2', 'relay', { decided: '- EU is out', ask: { kind: 'open-question' } })],
      query,
    );

    // Act
    const plan =
      candidate && joinPlan('fy', candidate, { ...request, decided: '- US is in', ask: { kind: 'open-question' } });

    // Assert
    should(plan?.kind).equal('edit');
    should(plan?.kind === 'edit' ? plan.command : '').containEql("--decided 'EU is out' --decided 'US is in'");
  });

  it('should not join an ask an edit cannot carry, and say what would be lost', () => {
    // Arrange
    const [candidate] = agendaCandidates([agentItem('A2', 'relay', { kind: 'info' })], query);
    const structured: (typeof request)[] = [
      { ...request, ask: { kind: 'multiple-choice' as const, options: [{ label: 'EU' }, { label: 'US' }] } },
      { ...request, blockingNow: true as const },
      { ...request, neededBy: '2026-08-01T09:00:00.000Z' },
      { ...request, body: 'the long story' },
      { ...request, why: 'a different reason' },
    ];

    // Act
    const plans = structured.map(each => candidate && joinPlan('fy', candidate, each));

    // Assert
    for (const plan of plans) should(plan?.kind).equal('new');
    should(plans.map(each => (each?.kind === 'new' ? each.carries : []))).eql([
      ['options to choose from'],
      ['blocking the ferret now'],
      ['a deadline'],
      ['a body'],
      ['a reason of its own (--why)'],
    ]);
  });

  it('should answer a structured ask with the safe way out that names the closest agenda', () => {
    // Arrange
    const [candidate] = agendaCandidates([agentItem('A2', 'relay')], query);
    const plan =
      candidate && joinPlan('fy', candidate, { ...request, blockingNow: true, neededBy: '2026-08-01T09:00:00.000Z' });

    // Act
    const advice = candidate && plan && joinAdvice('fy', candidate, plan);
    const out = candidate && plan && waysOut('fy', candidate, plan);

    // Assert
    should(advice).containEql('blocking the ferret now, a deadline');
    should(advice).containEql('fy agenda add … --new "<why none fits; closest is !A2>"');
    should(advice).not.containEql('fy agenda edit A2');
    should(out).equal(advice);
  });

  it('should tell a person who did not say yes both ways out for a plain ask', () => {
    // Arrange
    const [candidate] = agendaCandidates([agentItem('A2', 'relay')], query);
    const plan = candidate && joinPlan('fy', candidate, request);

    // Act
    const text = candidate && plan && waysOut('fy', candidate, plan);

    // Assert
    should(text).startWith('Nothing was opened. Join it to !A2:\n  fy agenda edit A2 --still-open');
    should(text).endWith(
      'or open a new agenda only when none passes the test:\n  fy agenda add … --new "<why none fits>"',
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

  it('should explain what a structured ask would lose instead of printing an edit', () => {
    // Act
    const text = renderCandidates(agendaCandidates([agentItem('A1', 'relay region')], query), {
      binary: 'zz',
      request: { ...request, blockingNow: true },
    });

    // Assert
    should(text).containEql('this ask has blocking the ferret now');
    should(text).not.containEql('zz agenda edit A1');
    should(text).endWith('  zz agenda add … --new "<why none fits; closest is !A1>"');
  });

  it('should end by saying a new agenda is opening anyway, with the reason or without one', () => {
    // Arrange
    const candidates = agendaCandidates([agentItem('A1', 'relay region')], query);

    // Act
    const reasoned = renderCandidates(candidates, { binary: 'zz', request, opening: 'the region is its own call' });
    const bare = renderCandidates(candidates, { binary: 'zz', request, opening: '' });

    // Assert
    should(reasoned).endWith('Opening a new agenda anyway: the region is its own call');
    should(bare).endWith('Opening a new agenda anyway: no reason was given.');
    should(renderCandidates([], { binary: 'zz', request })).equal('');
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
