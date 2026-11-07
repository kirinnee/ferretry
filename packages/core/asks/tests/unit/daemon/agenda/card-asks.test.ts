import { describe, it } from 'bun:test';
import { type AgendaCardAskAnswer, type AgendaGate, type AgendaItem } from '../../../../daemon/lib/protocol/agenda.ts';
import { agendaState } from '../../../../daemon/lib/protocol/agenda-state.ts';
import { cardAgendaReference } from '../../../../daemon/lib/protocol/agenda-card-asks.ts';
import should from 'should';
import {
  applyCardAsk,
  type CardAskOperation,
  type CardAskOutcome,
  sealCardAsks,
} from '../../../../daemon/lib/agenda/card-asks.ts';

const T0 = Date.parse('2026-11-03T08:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

const gate = (cardId: string): AgendaGate => ({
  cardId,
  laneId: 'tested',
  laneName: 'To test',
  entry: 2,
  projectId: 'ferretry',
  cardTitle: 'Badge',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
});
const reference = (cardId: string): string => `gate:${cardId}:tested:2`;

const answer: AgendaCardAskAnswer = {
  at: at(0),
  response: { kind: 'multiple-choice', choice: 'Done' },
  receipt: 'a'.repeat(64),
  askVersion: 1,
};

/** The effects of the state machine, reduced to what the pure half needs: the clock is the test's own. */
const world = () => {
  let now = at(0);
  const effects = {
    stage: (item: AgendaItem) => item,
    history: (item: AgendaItem, kind: 'updated' | 'gate-answered', note: string): AgendaItem => ({
      ...item,
      history: [...(item.history ?? []), { at: now, kind, note }],
    }),
    tidy: (item: AgendaItem) => item,
  };
  return {
    effects,
    apply: (item: AgendaItem, operation: CardAskOperation, minutes: number): CardAskOutcome => {
      now = at(minutes);
      return applyCardAsk(item, operation, now, effects);
    },
  };
};

const thread = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  ({
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    // A line that only repeats the card ask (docs/agenda.md § One ask): the card ask is all the thread asks.
    subject: 'Try it: Badge',
    title: 'Badge',
    why: 'w',
    howToResolve: 'h',
    waitingSince: at(-60),
    raisedBy: 'agent',
    raisedBySession: 'lead',
    raisedByName: 'Ada',
    ...extra,
  }) as AgendaItem;

const cardAgenda = (extra: Partial<AgendaItem> = {}): AgendaItem =>
  ({ ...thread(), raisedBy: 'daemon', sourceRef: cardAgendaReference('F1'), ...extra }) as AgendaItem;

const attach = (cardId: string): CardAskOperation => ({ kind: 'attach', ask: { gate: gate(cardId) } });
const withdraw = (cardId: string): CardAskOperation => ({ kind: 'withdraw', reference: reference(cardId) });

const changed = (outcome: CardAskOutcome): AgendaItem => {
  if (outcome.kind !== 'changed') throw new Error(`expected a change, got ${outcome.kind}`);
  return outcome.item;
};

describe('a withdrawn ask, and the turn it woke the thread out of', () => {
  it('leaves a thread the owner talked on after the ask woke it in Needs you, with the ferret’s answer', () => {
    // Arrange — the lead's thread rests "working"; F3's ask wakes it; the owner asks "what is F3?" and the lead answers
    const { apply } = world();
    const resting = thread({
      parked: { reason: 'replied', at: at(-30) },
      resting: { sub: 'working', at: at(-30) },
    });
    const woken = changed(apply(resting, attach('F3'), 1));
    const answered = {
      ...woken,
      history: [...(woken.history ?? []), { at: at(2), kind: 'replied' as const, note: 'what is F3?' }],
    };
    should(agendaState(answered).state).equal('needs-you');

    // Act — the owner drags F3 on the Board
    const after = changed(apply(answered, withdraw('F3'), 5));

    // Assert — the ferret's answer is still in front of them
    should(agendaState(after).state).equal('needs-you');
    should(after.resting).be.undefined();
    should(after.parked).be.undefined();
  });

  it('rests it on the owner’s answer that the ask kept in Needs you, and leaves it there when the ferret asked for more info', () => {
    // Arrange
    const { apply } = world();
    const woken = changed(apply(thread({ resting: { sub: 'working', at: at(-30) } }), attach('F3'), 1));
    const answered = {
      ...woken,
      ownerAnswer: { at: at(2), response: { kind: 'multiple-choice', choice: 'hm' }, request: 1 },
    };
    const asked = { ...woken, history: [{ at: at(2), kind: 'needs-info' as const }] };

    // Act
    const afterAnswer = changed(apply(answered as unknown as AgendaItem, withdraw('F3'), 5));
    const afterInfo = changed(apply(asked as unknown as AgendaItem, withdraw('F3'), 5));

    // Assert
    // The answer was kept open only by the waiting ask; with it gone, nothing is left for the owner (and the thread does not
    // go back to the turn it was woken out of: it is waiting on the ferret that was given the answer).
    should(agendaState(afterAnswer).state).equal('resting');
    should(afterAnswer.resting?.sub).equal('waiting-on-ferret');
    should(agendaState(afterInfo).state).equal('needs-you');
    should(afterInfo.resting).be.undefined();
  });

  it('still puts a thread back where it was when only the daemon’s own lines came after', () => {
    // Arrange
    const { apply } = world();
    const woken = changed(
      apply(
        thread({ parked: { reason: 'replied', at: at(-30) }, resting: { sub: 'working', at: at(-30) } }),
        attach('F3'),
        1,
      ),
    );

    // Act
    const after = changed(apply(woken, withdraw('F3'), 5));

    // Assert
    should(agendaState(after).state).not.equal('needs-you');
    should(after.resting?.sub).equal('working');
  });

  it('rests a thread the owner answered another ask on after the withdrawn one was put on', () => {
    // Arrange — A and B are open on the owner's turn; the owner answers A, which leaves it awake: B is still open
    const { apply } = world();
    const first = changed(apply(thread(), attach('F2'), 1));
    const both = changed(apply(first, attach('F3'), 2));
    const answeredA = changed(apply(both, { kind: 'answered', reference: reference('F2'), answer }, 3));
    should(agendaState(answeredA).state).equal('needs-you');

    // Act — B is withdrawn
    const after = changed(apply(answeredA, withdraw('F3'), 4));

    // Assert — the owner just answered on it: "any answer rests it"
    should(agendaState(after).state).equal('resting');
    should(after.parked?.reason).equal('replied');
    should(after.resting?.sub).equal('waiting-on-ferret');
  });

  it('puts a thread back to the rest an earlier answer put it in, since that answer came before the ask', () => {
    // Arrange — A is answered (the thread rests); B's ask wakes it out of that rest
    const { apply } = world();
    const first = changed(apply(thread(), attach('F2'), 1));
    const rested = changed(apply(first, { kind: 'answered', reference: reference('F2'), answer }, 2));
    const woken = changed(apply(rested, attach('F3'), 3));
    should(agendaState(woken).state).equal('needs-you');

    // Act
    const after = changed(apply(woken, withdraw('F3'), 4));

    // Assert — back to resting on its ferret
    should(agendaState(after).state).equal('resting');
    should(after.resting?.sub).equal('waiting-on-ferret');
  });

  it('keeps the waiting clock of an ask still open, but not when the owner talked since', () => {
    // Arrange — F2 and F3 asked at 1 and 2
    const { apply } = world();
    const both = changed(apply(changed(apply(thread(), attach('F2'), 1)), attach('F3'), 2));
    const talked = { ...both, history: [...(both.history ?? []), { at: at(3), kind: 'replied' as const, note: 'hm' }] };

    // Act
    const quiet = changed(apply(both, withdraw('F3'), 4));
    const spoken = changed(apply(talked, withdraw('F3'), 4));

    // Assert — the thread waited since F2 asked; after talk its clock is not touched
    should(quiet.waitingSince).equal(at(1));
    should(spoken.waitingSince).equal(at(2));
  });

  it('rests a thread when the only asks left are ones the owner said Not yet to, instead of leaving it in Needs you', () => {
    // Arrange — F2 gets Not yet (the thread rests); F3's ask wakes it out of that rest
    const { apply } = world();
    const first = changed(apply(thread(), attach('F2'), 1));
    const notYet = changed(apply(first, { kind: 'not-yet', reference: reference('F2'), note: 'later' }, 2));
    should(agendaState(notYet).state).equal('resting');
    const woken = changed(apply(notYet, attach('F3'), 3));
    should(agendaState(woken).state).equal('needs-you');

    // Act
    const after = changed(apply(woken, withdraw('F3'), 4));

    // Assert — F2 is open but waits on nothing new: back to rest
    should(agendaState(after).state).equal('resting');
    should(after.cardAsks?.map(ask => ask.gate.cardId)).eql(['F2']);
  });

  it('leaves a thread in Needs you when only Not yet asks are left but the owner talked on it since', () => {
    // Arrange — F2 gets Not yet; F3's ask wakes the thread; the owner then talks on it
    const { apply } = world();
    const first = changed(apply(thread(), attach('F2'), 1));
    const notYet = changed(apply(first, { kind: 'not-yet', reference: reference('F2') }, 2));
    const woken = changed(apply(notYet, attach('F3'), 3));
    const talked = { ...woken, history: [...(woken.history ?? []), { at: at(4), kind: 'replied' as const }] };

    // Act
    const after = changed(apply(talked, withdraw('F3'), 5));

    // Assert — talk since: the thread is left as it is
    should(agendaState(after).state).equal('needs-you');
  });

  it('rests the card’s own agenda when the only asks left are ones the owner said Not yet to', () => {
    // Arrange
    const { apply } = world();
    const first = changed(apply(cardAgenda(), attach('F2'), 1));
    const notYet = changed(apply(first, { kind: 'not-yet', reference: reference('F2') }, 2));
    const both = changed(apply(notYet, attach('F3'), 3));
    should(agendaState(both).state).equal('needs-you');

    // Act
    const after = changed(apply(both, withdraw('F3'), 4));

    // Assert
    should(agendaState(after).state).equal('resting');
    should(after.cardAsks).have.length(1);
  });
});

describe('a thread whose asks name no turn to go back to (from before they were kept)', () => {
  const old = (extra: Partial<AgendaItem> = {}): AgendaItem =>
    thread({
      cardAsks: [
        { gate: gate('F2'), at: at(1), answer },
        { gate: gate('F3'), at: at(2) },
      ],
      ...extra,
    });

  it('stays in Needs you when it is not sealed, since nothing says the daemon left it so', () => {
    // Arrange
    const { apply } = world();

    // Act
    const after = changed(apply(old(), withdraw('F3'), 5));

    // Assert
    should(agendaState(after).state).equal('needs-you');
    should(after.resting).be.undefined();
  });

  it('rests on the answer it holds when it is sealed and still as the daemon left it', () => {
    // Arrange
    const { apply } = world();

    // Act
    const after = changed(apply(sealCardAsks(old()), withdraw('F3'), 5));

    // Assert
    should(agendaState(after).state).equal('resting');
    should(after.resting?.sub).equal('waiting-on-ferret');
  });
});

describe('a card’s own agenda, when its only ask is withdrawn', () => {
  const talk = { at: at(2), kind: 'replied' as const, note: 'hm' };

  it('closes when nobody wrote on it, sealed or from before the seal', () => {
    // Arrange
    const { apply } = world();
    const sealed = changed(apply(sealCardAsks(cardAgenda()), attach('F1'), 1));
    const old = changed(apply(cardAgenda(), attach('F1'), 1));

    // Act
    const closedSealed = apply(sealed, withdraw('F1'), 3);
    const closedOld = apply(old, withdraw('F1'), 3);

    // Assert
    should(sealed.cardAsksSeal).be.a.String();
    should(old.cardAsksSeal).be.undefined();
    should(closedSealed.kind).equal('closed');
    should(closedOld.kind).equal('closed');
  });

  it('rests on its ferret when somebody wrote on it from before the seal, and stays rested when the owner replied', () => {
    // Arrange — a real reply rests the item as the state machine does
    const { apply } = world();
    const sealed = changed(apply(sealCardAsks(cardAgenda()), attach('F1'), 1));
    const old = changed(apply(cardAgenda(), attach('F1'), 1));
    const reply = {
      parked: { reason: 'replied' as const, at: at(2) },
      resting: { sub: 'waiting-on-ferret' as const, at: at(2) },
      history: [...(sealed.history ?? []), talk],
    };
    const sealedReply = { ...sealed, ...reply };
    const oldTalk = { ...old, history: [...(old.history ?? []), talk] };

    // Act
    const keptSealed = changed(apply(sealedReply, withdraw('F1'), 3));
    const restedOld = changed(apply(oldTalk, withdraw('F1'), 3));

    // Assert
    should(agendaState(keptSealed).state).equal('resting');
    should(keptSealed.resting?.at).equal(at(2));
    should(agendaState(restedOld).state).equal('resting');
  });

  it('leaves a sealed card agenda in Needs you when its ferret answered after the owner’s Not yet', () => {
    // Arrange — F2's ask is put on, the owner says Not yet (it rests), the ferret answers (back in Needs you)
    const { apply } = world();
    const asked = changed(apply(sealCardAsks(cardAgenda()), attach('F2'), 1));
    const notYet = changed(apply(asked, { kind: 'not-yet', reference: reference('F2') }, 2));
    const { parked: _parked, resting: _resting, ...awake } = notYet;
    const answered = { ...awake, questionAnswer: 'Fixed it, try again', waitingSince: at(3) } as AgendaItem;
    should(agendaState(answered).state).equal('needs-you');

    // Act — the card leaves the gate
    const after = changed(apply(answered, withdraw('F2'), 4));

    // Assert — the ferret's answer stays in front of the owner
    should(agendaState(after).state).equal('needs-you');
    should(after.questionAnswer).equal('Fixed it, try again');
  });

  it('rests when the owner answered, as an answer is what the agenda holds', () => {
    // Arrange
    const { apply } = world();
    const both = changed(apply(changed(apply(sealCardAsks(cardAgenda()), attach('F1'), 1)), attach('F2'), 2));
    const answered = changed(apply(both, { kind: 'answered', reference: reference('F1'), answer }, 3));

    // Act
    const after = changed(apply(answered, withdraw('F2'), 4));

    // Assert
    should(agendaState(after).state).equal('resting');
  });
});

describe('the seal across the Warden’s nudge and the stored form', () => {
  it('still reads a thread resting on a Not yet as untouched after the Warden nudged it', () => {
    // Arrange — F2 gets Not yet (the thread rests); the Warden nudges it; F3's ask wakes it
    const { apply } = world();
    const first = changed(apply(thread(), attach('F2'), 1));
    const notYet = changed(apply(first, { kind: 'not-yet', reference: reference('F2') }, 2));
    const nudged = {
      ...notYet,
      resting: { ...notYet.resting, nudgeSend: 'send-1', nudgedAt: at(40), nudges: 1 },
    } as AgendaItem;
    const woken = changed(apply(nudged, attach('F3'), 45));
    should(agendaState(woken).state).equal('needs-you');

    // Act — F3 leaves the gate
    const after = changed(apply(woken, withdraw('F3'), 50));

    // Assert — back to the rest it was woken out of, not stranded in Needs you
    should(agendaState(after).state).equal('resting');
    should(after.resting?.sub).equal('waiting-on-ferret');
  });

  it('seals the thread as it will be stored when the seal itself pushes it over the bound', () => {
    // Arrange — a store that sheds the oldest line while the thread is heavier than its bound
    const weigh = (item: AgendaItem): number => JSON.stringify(item).length;
    const lines = Array.from({ length: 4 }, (_, index) => ({
      at: at(-index - 1),
      kind: 'updated' as const,
      note: `line ${String(index)}`.padEnd(40, '.'),
    }));
    const base = thread({ history: lines });
    const plain = changed(applyCardAsk(base, { kind: 'attach', ask: { gate: gate('F2') } }, at(1), world().effects));
    const { cardAsksSeal: _seal, ...unsealed } = plain;
    const bound = weigh(unsealed) + 10;
    const store = (item: AgendaItem): AgendaItem => {
      let kept = item;
      while (weigh(kept) > bound && (kept.history ?? []).length > 1)
        kept = { ...kept, history: kept.history?.slice(1) };
      return kept;
    };
    const effects = { ...world().effects, tidy: store };

    // Act
    const outcome = applyCardAsk(base, { kind: 'attach', ask: { gate: gate('F2') } }, at(1), effects);
    const item = changed(outcome);

    // Assert — storing it again changes nothing, and the seal still matches
    should(item.cardAsksSeal).be.a.String();
    should(store(item)).eql(item);
    should(sealCardAsks(item)).eql(item);
    should((item.history ?? []).length).be.below(lines.length + 1);
  });
});

describe('one plain line of the daemon’s (a card with nothing to try)', () => {
  const line = (text: string): CardAskOperation => ({ kind: 'line', line: text });

  it('adds one activity line and changes nothing else: no ask, and the turn and place stay', () => {
    // Arrange — a ferret's thread, resting on its ferret, and a card agenda on the owner's turn
    const resting = thread({
      parked: { reason: 'replied', at: at(-5) },
      resting: { sub: 'waiting-on-ferret', at: at(-5) },
    });
    const { apply } = world();

    for (const item of [resting, thread(), cardAgenda()]) {
      // Act
      const next = changed(apply(item, line('&F1: Nothing to try: it is a private card'), 1));

      // Assert
      should(next.history).eql([{ at: at(1), kind: 'updated', note: '&F1: Nothing to try: it is a private card' }]);
      should(next.cardAsks).be.undefined();
      should(next.waitingSince).equal(item.waitingSince);
      should(next.parked).eql(item.parked);
      should(next.resting).eql(item.resting);
      should(agendaState(next).state).equal(agendaState(item).state);
    }
  });

  it('writes the same line once, not on every look', () => {
    // Arrange
    const { apply } = world();
    const once = changed(apply(thread(), line('&F1: Nothing to try: it is a private card'), 1));

    // Act
    const again = apply(once, line('&F1: Nothing to try: it is a private card'), 2);
    const other = apply(once, line('&F2: Nothing to try: it is a private card'), 2);

    // Assert
    should(again.kind).equal('unchanged');
    should(other.kind).equal('changed');
  });

  it('keeps a thread the daemon left untouched, so a later withdraw still reads it as the daemon’s', () => {
    // Arrange — an ask is attached (sealed), then the daemon's line is written
    const { apply } = world();
    const asked = changed(apply(thread(), attach('F2'), 0));
    should(asked.cardAsksSeal).be.a.String();

    // Act
    const noted = changed(apply(asked, line('&F1: Nothing to try: its PRs change only docs and tests'), 1));
    const withdrawn = changed(apply(noted, withdraw('F2'), 2));

    // Assert — the thread goes back to the turn the ask woke it out of, as it would have without the line
    should(agendaState(withdrawn).state).equal(agendaState(thread()).state);
    should(withdrawn.waitingSince).equal(thread().waitingSince);
  });
});
