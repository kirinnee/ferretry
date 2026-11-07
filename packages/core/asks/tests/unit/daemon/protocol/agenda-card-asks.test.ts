import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import should from 'should';
import { type AgendaCardAsk, type AgendaGate, AgendaItemSchema } from '../../../../daemon/lib/protocol/agenda.ts';
import {
  askedCardAsks,
  askLineRepeatsCardAsk,
  awaitsOwnAnswer,
  canCarryCardAsk,
  cardAgendaReference,
  cardAskOf,
  cardAskReference,
  cardAskStage,
  carriesCard,
  hasOpenCardAsk,
  isGeneratedCardAgendaAsk,
  itemAsksOwnQuestion,
  openCardAsks,
  ownAskDigest,
  ownCardAsk,
  parseCardAgendaReference,
  repliedToOwnAsk,
} from '../../../../daemon/lib/protocol/agenda-card-asks.ts';
import { canonicalJson } from '@ferretry/std';
import { type AgendaQueueSource, needsYouQueue } from '../../../../daemon/lib/protocol/agenda-queue.ts';

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
  it('should keep the unanswered ones, oldest first, and ask the first of them first', () => {
    const item = { cardAsks: [answered('F1'), open('F2'), open('F3')] };

    should(openCardAsks(item).map(ask => ask.gate.cardId)).deepEqual(['F2', 'F3']);
    should(hasOpenCardAsk(item)).be.true();
    should(askedCardAsks(item)[0]?.gate.cardId).equal('F2');
    should(hasOpenCardAsk({ cardAsks: [answered('F1')] })).be.false();
    should(hasOpenCardAsk({})).be.false();
    should(askedCardAsks({})[0]).be.undefined();
  });

  it('should ask a Not yet after every ask still waiting, so the next one is asked first', () => {
    // Arrange — two approvals, F12 then F13; the owner said Not yet to F12
    const deferred = (cardId: string, at: string): AgendaCardAsk => ({ ...open(cardId), notYet: { at } });
    const item = { cardAsks: [deferred('F12', LATER), open('F13')] };

    // Act
    const order = askedCardAsks(item).map(ask => ask.gate.cardId);

    // Assert
    should(order).deepEqual(['F13', 'F12']);
    should(askedCardAsks(item)[0]?.gate.cardId).equal('F13');
  });

  it('should ask the Not yet set aside longest ago first, so a second Not yet moves on rather than re-trapping', () => {
    // Arrange — both set aside: F13 after F12, then F12 again
    const deferred = (cardId: string, at: string): AgendaCardAsk => ({ ...open(cardId), notYet: { at } });
    const both = { cardAsks: [deferred('F12', AT), deferred('F13', LATER)] };
    const again = { cardAsks: [deferred('F12', '2026-11-03T11:00:00.000Z'), deferred('F13', LATER)] };
    const tied = { cardAsks: [deferred('F12', AT), deferred('F13', AT), answered('F14')] };

    // Act / Assert — the one set aside longest ago comes first; a tie keeps the order the asks were put on
    should(askedCardAsks(both).map(ask => ask.gate.cardId)).deepEqual(['F12', 'F13']);
    should(askedCardAsks(again)[0]?.gate.cardId).equal('F13');
    should(askedCardAsks(tied).map(ask => ask.gate.cardId)).deepEqual(['F12', 'F13']);
    should(askedCardAsks({})).deepEqual([]);
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
    should(twice.error?.issues.map(issue => issue.message)).containEql('an agenda carries each ask about a card once');
  });

  it('should carry the turn an ask woke the agenda out of, and read without it', () => {
    const woke = {
      waitingSince: AT,
      resting: { sub: 'working' as const, at: AT },
      parked: { reason: 'replied' as const, at: AT },
    };
    const withBoth = AgendaItemSchema.safeParse({
      ...item([{ ...open('F412'), woke }]),
    });
    should(withBoth.success).be.true();
    should(withBoth.data?.cardAsks?.[0]?.woke?.resting?.sub).equal('working');
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

describe('ownCardAsk: the one ask of a card’s own agenda', () => {
  const own = { raisedBy: 'daemon', sourceRef: 'card-agenda:F12', cardAsks: [open('F12')] } as const;

  it('is the open ask of the agenda the daemon opened for the card', () => {
    should(ownCardAsk(own)).eql(open('F12'));
  });

  it('is nothing for a ferret’s own thread, however many asks it carries', () => {
    should(ownCardAsk({ ...own, raisedBy: 'agent', sourceRef: 'task:F12' })).be.undefined();
    should(ownCardAsk({ ...own, raisedBy: 'agent' })).be.undefined();
  });

  it('is nothing when the card agenda has no open ask or more than one', () => {
    should(ownCardAsk({ ...own, cardAsks: [{ ...open('F12'), answer: undefined }, open('F13')] })).be.undefined();
    should(ownCardAsk({ ...own, cardAsks: [] })).be.undefined();
    should(ownCardAsk({ raisedBy: 'daemon', sourceRef: 'card-agenda:F12' })).be.undefined();
  });
});

describe('the generated card agenda ask', () => {
  const tryIt = (answer?: AgendaCardAsk['answer']): AgendaCardAsk => ({
    gate: gate('F12', 1, 'reopen-with-agenda'),
    at: AT,
    howToTest: '1. The badge counts unread items.\n2. Open the Inbox.',
    ...(answer === undefined ? {} : { answer }),
  });
  const SUBJECT = 'Try it: the badge counts unread items.';
  const daemon = {
    raisedBy: 'daemon' as const,
    sourceRef: 'card-agenda:F12',
    ask: { kind: 'open-question' as const },
    subject: SUBJECT,
    generatedSubject: SUBJECT,
    cardAsks: [tryIt()],
  };

  it('should hold while the subject is still exactly the one the daemon last wrote', () => {
    should(isGeneratedCardAgendaAsk(daemon)).be.true();
  });

  it('should stop holding once anyone rewrote the subject, however long ago (no revision tail is read)', () => {
    should(isGeneratedCardAgendaAsk({ ...daemon, subject: 'Should the badge also change keyboard focus?' })).be.false();
    // Even a rewrite in the lane's own words is the rewriter's once a generated subject is on record.
    should(isGeneratedCardAgendaAsk({ ...daemon, subject: 'Try it: and the focus ring too?' })).be.false();
  });

  it('should stop holding once the item asks questions, fields, steps or a non-open ask of its own', () => {
    should(isGeneratedCardAgendaAsk({ ...daemon, questions: [{ question: 'Which?' }] })).be.false();
    should(isGeneratedCardAgendaAsk({ ...daemon, fields: [{ id: 'f', label: 'Name', type: 'text' }] })).be.false();
    should(isGeneratedCardAgendaAsk({ ...daemon, steps: ['Open the app'] })).be.false();
    should(isGeneratedCardAgendaAsk({ ...daemon, ask: { kind: 'permission' } })).be.false();
  });

  it('should never let a lane prefix alone hide a question on a card agenda from before the generated subject', () => {
    const { generatedSubject: _generated, ...legacy } = daemon;
    // The upgrade path: a ferret rewrote it before `generatedSubject` existed, keeping the "Try it:" opening.
    const rewritten = {
      ...legacy,
      subject: 'Try it: the badge counts unread items. Should keyboard focus change too?',
    };
    should(isGeneratedCardAgendaAsk(rewritten)).be.false();
    should(itemAsksOwnQuestion(rewritten, rewritten.cardAsks)).be.true();
  });

  it('should read a card agenda from before the generated subject by the lane words of one of its card asks', () => {
    const { generatedSubject: _generated, ...legacy } = daemon;
    should(isGeneratedCardAgendaAsk(legacy)).be.true();
    // The answered ask still wrote the subject: Good does not turn it into a question of its own.
    should(isGeneratedCardAgendaAsk({ ...legacy, cardAsks: [tryIt(answered('F12').answer)] })).be.true();
    should(isGeneratedCardAgendaAsk({ ...legacy, subject: 'Should the badge also change keyboard focus?' })).be.false();
    should(isGeneratedCardAgendaAsk({ ...legacy, cardAsks: undefined })).be.false();
  });

  it('should never hold for an item that is not the daemon’s card agenda', () => {
    should(isGeneratedCardAgendaAsk({ ...daemon, raisedBy: 'agent' })).be.false();
    should(isGeneratedCardAgendaAsk({ ...daemon, sourceRef: 'gate:F12:tested:1' })).be.false();
    should(isGeneratedCardAgendaAsk({ ...daemon, sourceRef: null })).be.false();
  });

  it('should keep the generated subject on the stored item, so an old app may drop it', () => {
    const parsed = AgendaItemSchema.safeParse({
      id: 'A1',
      source: 'task',
      sourceRef: 'card-agenda:F12',
      subject: SUBJECT,
      generatedSubject: SUBJECT,
      why: 'F12 reached Ready to try.',
      context: null,
      waitingSince: AT,
      howToResolve: 'Try it.',
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
    });
    should(parsed.success).be.true();
    should(parsed.success && parsed.data.generatedSubject).equal(SUBJECT);
  });
});

describe('an ask line that repeats a card ask', () => {
  const ask = {
    gate: { ...gate('F12', 1, 'reopen-with-agenda'), cardTitle: 'Unread badge' },
    howToTest: '1. Open the Inbox. Look at the corner.\n2. **Mark** one item read.',
  };

  it('should hold for the lane words alone, or followed by the card title or one whole step', () => {
    should(askLineRepeatsCardAsk('Try it:', [ask])).be.true();
    should(askLineRepeatsCardAsk('Try it: Unread badge', [ask])).be.true();
    should(askLineRepeatsCardAsk('Try it: Mark one item read.', [ask])).be.true();
    // A step clipped at its first sentence, as the daemon clips the line.
    should(askLineRepeatsCardAsk('Try it: Open the Inbox', [ask])).be.true();
  });

  it('should not hold for anything else, even a line quoting part of a step', () => {
    should(askLineRepeatsCardAsk('Try it: Open the', [ask])).be.false();
    should(askLineRepeatsCardAsk('Try it: does the badge also change keyboard focus?', [ask])).be.false();
    should(askLineRepeatsCardAsk('Open the Inbox.', [ask])).be.false();
    should(askLineRepeatsCardAsk('Try it: Unread badge', [])).be.false();
    should(askLineRepeatsCardAsk('Try it: Mark one item read.', [{ ...ask, howToTest: null }])).be.false();
  });

  it('should read an approval lane by its first option', () => {
    const plan = { gate: { ...gate('F12'), options: [{ id: 'o0', label: 'OK to build', outcome: 'close' as const }] } };
    should(askLineRepeatsCardAsk('OK to build?', [plan])).be.true();
    should(askLineRepeatsCardAsk('OK to build? Should it also cover the CLI?', [plan])).be.false();
  });
});

describe('whether an item asks its own question beside its card asks', () => {
  const asks = [{ gate: { ...gate('F12', 1, 'reopen-with-agenda'), cardTitle: 'Unread badge' }, howToTest: null }];
  const thread = {
    raisedBy: 'agent' as const,
    sourceRef: null,
    ask: { kind: 'open-question' as const },
    subject: 'Should the badge also change keyboard focus?',
  };
  const cardAgenda = {
    raisedBy: 'daemon' as const,
    sourceRef: 'card-agenda:F12',
    ask: { kind: 'open-question' as const },
    subject: 'Try it: the badge counts unread items.',
    generatedSubject: 'Try it: the badge counts unread items.',
    cardAsks: [open('F12')],
  };

  it('should hold for a ferret’s subject-only question', () => {
    should(itemAsksOwnQuestion(thread, asks)).be.true();
  });

  it('should hold for questions, fields or steps, whatever the line says', () => {
    should(itemAsksOwnQuestion({ ...cardAgenda, questions: [{ question: 'Which?' }] }, asks)).be.true();
    should(itemAsksOwnQuestion({ ...thread, subject: 'Try it: Unread badge', steps: ['Open it'] }, asks)).be.true();
  });

  it('should not hold for the daemon’s generated card agenda ask, nor a line that only repeats the card ask', () => {
    should(itemAsksOwnQuestion(cardAgenda, asks)).be.false();
    should(itemAsksOwnQuestion({ ...thread, subject: 'Try it: Unread badge' }, asks)).be.false();
  });

  it('should hold for a card agenda whose subject a ferret rewrote into a question', () => {
    should(
      itemAsksOwnQuestion({ ...cardAgenda, subject: 'Should the badge also change keyboard focus?' }, asks),
    ).be.true();
  });
});

describe('whether the item’s own question still waits for the owner (awaitsOwnAnswer)', () => {
  const asks = [open('F12')];
  const question = {
    raisedBy: 'agent' as const,
    sourceRef: null,
    ask: { kind: 'open-question' as const },
    subject: 'Should the badge also change keyboard focus?',
  };

  it('should hold for an unanswered question, and not once the owner replied to it as it stands', () => {
    should(awaitsOwnAnswer(question, asks)).be.true();
    should(awaitsOwnAnswer({ ...question, ownAskRepliedTo: ownAskDigest(question) }, asks)).be.false();
  });

  it('should hold again once the question is reworded or re-asked, whatever was answered before', () => {
    const replied = { ...question, ownAskRepliedTo: ownAskDigest(question) };

    should(awaitsOwnAnswer({ ...replied, subject: 'Should it also announce itself?' }, asks)).be.true();
    should(awaitsOwnAnswer({ ...replied, askVersion: 2 }, asks)).be.true();
    should(repliedToOwnAsk({ ...replied, askVersion: 2 })).be.false();
  });

  it('should not hold for a notice, an owner’s answer, or an item that asks nothing of its own', () => {
    should(awaitsOwnAnswer({ ...question, notice: true }, asks)).be.false();
    should(
      awaitsOwnAnswer(
        { ...question, ownerAnswer: { at: AT, response: { kind: 'open-question', answer: 'no' }, request: 1 } },
        asks,
      ),
    ).be.false();
    should(
      awaitsOwnAnswer(
        {
          raisedBy: 'daemon',
          sourceRef: 'card-agenda:F12',
          ask: question.ask,
          subject: 'Try it: the badge.',
          generatedSubject: 'Try it: the badge.',
          cardAsks: asks,
        },
        asks,
      ),
    ).be.false();
  });

  it('should hold for a choice, permission or review with no answer yet', () => {
    should(awaitsOwnAnswer({ ...question, ask: { kind: 'permission' as const } }, asks)).be.true();
  });
});

describe('the digest of the item’s own ask', () => {
  const item = { subject: ' Should the badge change? ', ask: { kind: 'open-question' as const } };

  it('should be the first 32 hex digits of SHA-256 over the canonical spelling both ends share', () => {
    const spelled = canonicalJson({ line: 'Should the badge change?', ask: item.ask, version: 1 });
    if (!spelled.ok) throw new Error('canonical');

    should(ownAskDigest(item)).equal(createHash('sha256').update(spelled.text, 'utf8').digest('hex').slice(0, 32));
  });

  it('should move with the question, its version and its fields, and not with a trailing space', () => {
    const base = ownAskDigest(item);

    should(ownAskDigest({ ...item, subject: 'Should the badge change?' })).equal(base);
    should(ownAskDigest({ ...item, askVersion: 2 })).not.equal(base);
    should(ownAskDigest({ ...item, steps: ['Open it'] })).not.equal(base);
  });
});
