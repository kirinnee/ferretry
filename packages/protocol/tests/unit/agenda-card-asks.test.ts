import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaCardAsk, AgendaGate } from '../../src/lib/agenda.ts';
import {
  cardAgendaReference,
  cardAskOf,
  cardAskReference,
  cardAskStage,
  carriesCard,
  hasOpenCardAsk,
  mirroredCardAsk,
  openCardAsks,
  parseCardAgendaReference,
} from '../../src/lib/agenda-card-asks.ts';
import { type AgendaQueueSource, needsYouQueue } from '../../src/lib/agenda-queue.ts';

const AT = '2026-11-03T09:00:00.000Z';
const LATER = '2026-11-03T10:00:00.000Z';

const gate = (cardId: string, entry = 1, outcome: 'close' | 'reopen-with-agenda' = 'close'): AgendaGate => ({
  cardId,
  laneId: 'tested',
  laneName: 'Ready to try',
  entry,
  projectId: 'p-1',
  options: [{ id: 'o0', label: 'Done', outcome }],
});
const open = (cardId: string, entry = 1): AgendaCardAsk => ({ gate: gate(cardId, entry), at: AT });
const answered = (cardId: string, entry = 1): AgendaCardAsk => ({
  ...open(cardId, entry),
  answer: { at: LATER, response: { kind: 'multiple-choice', choice: 'Done' }, receipt: 'a'.repeat(64) },
});

describe('the card agenda reference', () => {
  it('should name the card, and read back only a card', () => {
    should(cardAgendaReference('F12')).equal('card-agenda:F12');
    should(parseCardAgendaReference('card-agenda:F12')).equal('F12');
    should(parseCardAgendaReference('card-agenda:F0')).be.undefined();
    should(parseCardAgendaReference('card-agenda:F12:x')).be.undefined();
    should(parseCardAgendaReference('gate:F12:tested:1')).be.undefined();
    should(parseCardAgendaReference(null)).be.undefined();
  });
});

describe('open card asks', () => {
  it('should keep the unanswered ones, oldest first, and mirror the first for an older app', () => {
    const item = { cardAsks: [answered('F1'), open('F2'), open('F3')] };

    should(openCardAsks(item).map(ask => ask.gate.cardId)).deepEqual(['F2', 'F3']);
    should(hasOpenCardAsk(item)).be.true();
    should(mirroredCardAsk(item)?.gate.cardId).equal('F2');
    should(hasOpenCardAsk({ cardAsks: [answered('F1')] })).be.false();
    should(hasOpenCardAsk({})).be.false();
    should(mirroredCardAsk({})).be.undefined();
  });

  it('should find an ask by its gate reference, open or answered', () => {
    const item = { cardAsks: [answered('F1'), open('F1', 2)] };

    should(cardAskReference(open('F1', 2))).equal('gate:F1:tested:2');
    should(cardAskOf(item, 'gate:F1:tested:1')?.answer).not.be.undefined();
    should(cardAskOf(item, 'gate:F1:tested:2')?.answer).be.undefined();
    should(cardAskOf(item, 'gate:F1:tested:3')).be.undefined();
  });

  it('should ask for a test when its gate can send the card back with words, else for a plan', () => {
    should(cardAskStage(gate('F1', 1, 'reopen-with-agenda'))).equal('test');
    should(cardAskStage(gate('F1'))).equal('plan');
  });
});

describe('carriesCard', () => {
  it('should carry the card it is about, a merged-in card, and every card it asks for', () => {
    should(carriesCard({ task: { id: 'F1' } }, 'F1')).be.true();
    should(carriesCard({ task: { id: 'F9' }, relatedTasks: [{ id: 'F1' }] }, 'F1')).be.true();
    should(carriesCard({ task: { id: 'F9' }, cardAsks: [answered('F1')] }, 'F1')).be.true();
    should(carriesCard({ task: { id: 'F9' } }, 'F1')).be.false();
  });

  it('should tell machines apart only when both name one, and never let a notice carry anything', () => {
    should(carriesCard({ task: { id: 'F1', machineId: 'm-1' } }, 'F1', 'm-2')).be.false();
    should(carriesCard({ task: { id: 'F1', machineId: 'm-1' } }, 'F1', 'm-1')).be.true();
    should(carriesCard({ task: { id: 'F1' } }, 'F1', 'm-2')).be.true();
    should(carriesCard({ task: { id: 'F1' }, notice: true }, 'F1')).be.false();
  });
});

describe('needsYouQueue and card asks', () => {
  it('should put an agenda with an open card ask among the blockers, and an answered one back by time', () => {
    const items = [
      { id: 'A1', waitingSince: AT },
      { id: 'A2', waitingSince: LATER, cardAsks: [open('F1')] },
      { id: 'A3', waitingSince: LATER, blockingNow: true as const },
      { id: 'A4', waitingSince: AT, cardAsks: [answered('F2')] },
    ] as AgendaQueueSource[];

    should(needsYouQueue(items).map(each => each.id)).deepEqual(['A2', 'A3', 'A1', 'A4']);
  });
});
