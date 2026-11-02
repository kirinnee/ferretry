import { describe, it } from 'bun:test';
import { type ResolvedAgendaItem, ResolvedAgendaItemSchema } from '@ferretry/protocol';
import should from 'should';
import {
  approvalProblem,
  cardLicence,
  offBoardRefusal,
  ownerAskedForTracking,
  TRACKING_WORDS,
} from '../../../src/lib/board/index.ts';
import { NOW } from './support.ts';

const FERRET = 'mvysjsw0-7071db05';

/** The owner's answered "Track this on the board?" on the ferret's own agenda, with whatever a case changes. */
const answered = (extra: Record<string, unknown> = {}): ResolvedAgendaItem =>
  ResolvedAgendaItemSchema.parse({
    id: 'A12',
    raisedBy: 'agent',
    raisedBySession: FERRET,
    raisedByName: null,
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Track this on the board?',
    why: 'the login fix spans three PRs',
    context: null,
    howToResolve: 'Yes puts it on the board; No keeps it off',
    waitingSince: NOW,
    kind: 'yesno',
    ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
    resolvedAt: NOW,
    resolutionNote: null,
    response: { kind: 'multiple-choice', choice: 'Yes' },
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    ...extra,
  });

const OWNER_ASKS_FOR_A_CARD = 'please make a card for the login redesign so I can follow it on the board';
const facts = {
  boardOn: false,
  parent: false,
  approved: false,
  askText: OWNER_ASKS_FOR_A_CARD,
  ownerSaid: [] as readonly string[],
};

describe('whether a ferret may make a card', () => {
  it('should let any card through where the board is on', () => {
    should(cardLicence({ ...facts, boardOn: true, parent: true, approved: true })).equal('board-on');
  });

  it('should let a card under a parent the ferret holds through where the board is off', () => {
    should(cardLicence({ ...facts, parent: true, approved: true })).equal('parent');
  });

  it("should let a card on the owner's Yes through where the board is off", () => {
    should(cardLicence({ ...facts, approved: true, ownerSaid: [OWNER_ASKS_FOR_A_CARD] })).equal('approval');
  });

  it("should let a card through whose ask is the owner's words asking for a card", () => {
    should(cardLicence({ ...facts, ownerSaid: ['hi', OWNER_ASKS_FOR_A_CARD] })).equal('owner-words');
  });

  it("should refuse a card whose ask is the owner's words when those words never ask for tracking", () => {
    // Arrange
    const ask = 'please fix the login redirect loop on the phone app today';

    // Act
    const licence = cardLicence({ ...facts, askText: ask, ownerSaid: [ask] });

    // Assert
    should(licence).be.null();
  });

  it("should refuse a card whose ask is the ferret's own words", () => {
    should(cardLicence({ ...facts, ownerSaid: ['fix the login loop'] })).be.null();
  });

  it('should refuse a card with nothing behind it', () => {
    should(cardLicence(facts)).be.null();
  });
});

describe('the words that ask for tracking', () => {
  it('should name a card, the board, a ticket or tracking', () => {
    for (const words of [
      'a card',
      'cards',
      'the board',
      'boards',
      'a ticket',
      'track it',
      'tracks',
      'tracked',
      'tracking',
    ]) {
      should(TRACKING_WORDS.test(words)).be.true(words);
    }
  });

  it('should not read "task" or a word that only contains one of them', () => {
    for (const words of ['dont use actioned tasks', 'discard it', 'keyboard', 'racetrack', 'onboarding']) {
      should(TRACKING_WORDS.test(words)).be.false(words);
    }
  });

  it("should match only the owner's messages that ask for tracking", () => {
    should(ownerAskedForTracking(OWNER_ASKS_FOR_A_CARD, [OWNER_ASKS_FOR_A_CARD])).be.true();
    should(ownerAskedForTracking(OWNER_ASKS_FOR_A_CARD, [])).be.false();
  });
});

describe("the owner's Yes", () => {
  it('should count an answered yes/no about tracking that the ferret raised', () => {
    should(approvalProblem('A12', answered(), FERRET, undefined)).be.null();
  });

  it('should count a Yes however it is cased', () => {
    // Arrange
    const item = answered({
      ask: { kind: 'multiple-choice', options: [{ label: 'yes' }, { label: 'NO' }] },
      response: { kind: 'multiple-choice', choice: 'yes' },
    });

    // Act
    const problem = approvalProblem('A12', item, FERRET, undefined);

    // Assert
    should(problem).be.null();
  });

  it('should refuse an item that is not answered on the ferret’s agenda', () => {
    should(approvalProblem('A12', undefined, FERRET, undefined)).equal('!A12 is not an answered item on your agenda');
  });

  it('should refuse an item another ferret, the daemon or the owner raised', () => {
    const others = [
      answered({ raisedBySession: 'someone-else' }),
      answered({ raisedBy: 'daemon', raisedBySession: null }),
      answered({ raisedBy: 'human', raisedBySession: null }),
    ];
    for (const item of others) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('!A12 is not an item you raised');
    }
  });

  it('should refuse an item that is not a yes/no question', () => {
    // Arrange
    const choice = answered({
      kind: 'choice',
      ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'Later' }] },
    });
    const open = answered({ kind: 'reply', ask: { kind: 'open-question' }, response: undefined });

    // Act & Assert
    should(approvalProblem('A12', choice, FERRET, undefined)).equal('!A12 is not a yes/no question');
    should(approvalProblem('A12', open, FERRET, undefined)).equal('!A12 is not a yes/no question');
  });

  it('should refuse a Yes to a question that never mentions tracking', () => {
    // Arrange
    const item = answered({ subject: 'Ship the fix?', why: 'it is ready', howToResolve: 'Yes ships it' });

    // Act
    const problem = approvalProblem('A12', item, FERRET, undefined);

    // Assert
    should(problem).equal('!A12 does not ask about tracking this on the board');
  });

  it('should refuse an item the ferret or the daemon closed', () => {
    const closers = [
      answered({ resolvedBy: 'agent', resolvedBySession: FERRET, resolvedByName: null }),
      answered({ resolvedBy: 'daemon' }),
    ];
    for (const item of closers) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('!A12 was not answered by the owner');
    }
  });

  it('should refuse a No, a dismissal and a reply', () => {
    const notYes = [
      answered({ response: { kind: 'multiple-choice', choice: 'No' } }),
      answered({ disposition: 'dismissed', response: undefined }),
      answered({ disposition: 'replied', response: undefined }),
      answered({ response: { kind: 'other', answer: 'not yet' } }),
    ];
    for (const item of notYes) {
      should(approvalProblem('A12', item, FERRET, undefined)).equal('the owner did not answer Yes to !A12');
    }
  });

  it('should refuse a Yes that already made a card', () => {
    should(approvalProblem('A12', answered(), FERRET, { id: 'F7' })).equal(
      '!A12 already made &F7; one Yes makes one card',
    );
  });
});

describe('the refusal', () => {
  it('should say the board is off, what to do instead and how to ask', () => {
    should(offBoardRefusal('ferretry')).equal(
      'The ferretry board is off, so this work needs no card: put only what the owner must decide or do on your agenda (fy agenda add …). To track it anyway, ask first: fy agenda add -k yesno "Track this on the board?" — then, once the owner says Yes, fy task create … --approval !A<n>.',
    );
  });

  it('should say why a named approval did not count', () => {
    should(offBoardRefusal('ferretry', 'the owner did not answer Yes to !A12')).containEql(
      'The approval does not count: the owner did not answer Yes to !A12.',
    );
  });
});
