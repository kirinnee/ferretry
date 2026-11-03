import { describe, it } from 'bun:test';
import should from 'should';
import { type AgendaCardAsk, type AgendaGate, AgendaItemSchema } from '../../src/lib/agenda.ts';
import {
  asksOnlyCardAsks,
  canCarryCardAsk,
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

describe('an agenda item’s card asks', () => {
  const item = (cardAsks: readonly AgendaCardAsk[]) => ({
    id: 'A6',
    source: 'task',
    sourceRef: 'card-agenda:F412',
    subject: 'Try it: open the Board',
    why: '&F412 reached Released.',
    waitingSince: AT,
    howToResolve: 'Answer the card’s ask here.',
    kind: 'reply',
    ask: { kind: 'open-question' },
    task: { id: 'F412' },
    cardAsks,
    raisedBy: 'daemon',
    raisedBySession: null,
    raisedByName: null,
  });

  it('should carry each card ask once', () => {
    should(AgendaItemSchema.safeParse(item([open('F412'), open('F412', 2)])).success).be.true();
    const twice = AgendaItemSchema.safeParse(item([open('F412'), answered('F412')]));
    should(twice.success).be.false();
    should(twice.error?.issues.map(issue => issue.message)).containEql('an agenda carries each card ask once');
  });

  it('should carry the turn an ask woke the agenda out of, and when the mirror last changed, and read without them', () => {
    const woke = {
      waitingSince: AT,
      resting: { sub: 'working' as const, at: AT },
      parked: { reason: 'replied' as const, at: AT },
    };
    const withBoth = AgendaItemSchema.safeParse({
      ...item([{ ...open('F412'), woke }]),
      gateAttachedChangedAt: LATER,
    });
    should(withBoth.success).be.true();
    should(withBoth.data?.cardAsks?.[0]?.woke?.resting?.sub).equal('working');
    should(withBoth.data?.gateAttachedChangedAt).equal(LATER);
    should(AgendaItemSchema.safeParse(item([open('F412')])).success).be.true();
    should(AgendaItemSchema.safeParse(item([{ ...open('F412'), woke: { waitingSince: 'soon' } }])).success).be.false();
  });
});

const thread = {
  notice: undefined,
  gate: undefined,
  kind: 'reply' as const,
  confirms: undefined,
  copyPlan: undefined,
  taskPlan: undefined,
  twoFactorSeed: undefined,
  phoneApproval: undefined,
  signInRuleSuggestion: undefined,
  signInRuleSuspended: undefined,
  raisedBy: 'agent' as const,
  source: 'agent-raised' as const,
  sourceRef: null,
};

describe('which agendas can carry a card ask', () => {
  it('should let a ferret’s own thread, and the daemon’s card agenda and Not good conversation, carry one', () => {
    should(canCarryCardAsk(thread)).be.true();
    should(canCarryCardAsk({ ...thread, raisedBy: 'daemon', source: 'task', sourceRef: 'card-agenda:F1' })).be.true();
    should(
      canCarryCardAsk({ ...thread, raisedBy: 'daemon', source: 'task', sourceRef: 'gate-followup:F1:2' }),
    ).be.true();
  });

  it('should refuse every item that is answered another way', () => {
    should(canCarryCardAsk({ ...thread, notice: true })).be.false();
    should(canCarryCardAsk({ ...thread, kind: 'input' })).be.false();
    should(canCarryCardAsk({ ...thread, raisedBy: 'daemon', source: 'task', sourceRef: null })).be.false();
    should(
      canCarryCardAsk({ ...thread, raisedBy: 'daemon', source: 'task', sourceRef: 'gate:F1:tested:2' }),
    ).be.false();
    for (const field of [
      'confirms',
      'copyPlan',
      'taskPlan',
      'twoFactorSeed',
      'phoneApproval',
      'signInRuleSuggestion',
      'signInRuleSuspended',
    ] as const)
      should(canCarryCardAsk({ ...thread, [field]: {} as never })).be.false();
  });
});

describe('an agenda that asks only card asks', () => {
  const base = { raisedBy: 'agent' as const, sourceRef: null, waitingSince: AT };

  it('should be false with no open ask', () => {
    should(asksOnlyCardAsks({ ...base })).be.false();
    should(asksOnlyCardAsks({ ...base, cardAsks: [answered('F1')] })).be.false();
  });

  it('should be true for the daemon’s card agenda, whatever else is on it', () => {
    should(
      asksOnlyCardAsks({
        raisedBy: 'daemon',
        sourceRef: 'card-agenda:F1',
        waitingSince: LATER,
        cardAsks: [open('F1')],
      }),
    ).be.true();
  });

  it('should be true for a thread the ask was put on after its last question, false when the ferret asked since', () => {
    should(asksOnlyCardAsks({ ...base, cardAsks: [{ ...open('F1'), at: LATER }] })).be.true();
    should(asksOnlyCardAsks({ ...base, waitingSince: LATER, cardAsks: [open('F1')] })).be.false();
  });
});
