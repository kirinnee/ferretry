import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENDA_QUOTE_CHARS,
  agendaAnswerMessage,
  agendaBatchMessage,
  agendaDiscussMessage,
  agendaDismissedMessage,
  agendaDoneMessage,
  agendaNeedsInfoMessage,
  agendaQuote,
  agendaReMessage,
  parseAgendaMessage,
} from '../../src/lib/agenda-message.ts';

const ask = { id: 'A45', quote: 'How should outdated ferrets pick up new instructions after an update?' };
const other = { id: 'A7', quote: 'Ship it?' };

describe('the agenda chat forms — the words the daemon writes', () => {
  it('words an answer, with a note only when it adds something', () => {
    should(agendaAnswerMessage(ask, 'Button only')).equal(
      '[answer to !A45 «How should outdated ferrets pick up new instructions after an update?»] Button only',
    );
    should(agendaAnswerMessage(other, 'Yes', 'today')).equal('[answer to !A7 «Ship it?»] Yes · note: today');
    should(agendaAnswerMessage(other, 'Yes', 'Yes')).equal('[answer to !A7 «Ship it?»] Yes');
  });

  it('words a done, a dismiss, a request for information and a discussion', () => {
    should(agendaDoneMessage(other)).equal('[done !A7 «Ship it?»] The owner marked this done.');
    should(agendaDismissedMessage(other)).equal(
      '[dismissed !A7 «Ship it?»] Not needed — the owner dismissed this without a reason.',
    );
    should(agendaDismissedMessage(other, 'stale')).equal('[dismissed !A7 «Ship it?»] Not needed: stale');
    should(agendaNeedsInfoMessage(other)).equal('[needs more info !A7 «Ship it?»] The owner needs more information.');
    should(agendaNeedsInfoMessage(other, 'which branch?')).equal('[needs more info !A7 «Ship it?»] which branch?');
    should(agendaDiscussMessage(other, '', 'fy')).equal(
      '[discuss !A7 «Ship it?»] The owner wants to talk this through before answering: no note. Reply in chat to clear it up; then update the item (`fy agenda edit A7`) or close it if the premise was wrong (`fy agenda done A7`).',
    );
  });

  it('names several items in one reply, and joins a batch a blank line apart', () => {
    should(agendaReMessage([ask, other], 'both?')).equal(
      '[re !A45 «How should outdated ferrets pick up new instructions after an update?», !A7 «Ship it?»] both?',
    );
    should(agendaBatchMessage(['a', 'b'])).equal('a\n\nb');
  });

  it('cuts a long ask at the quote limit and marks the cut', () => {
    const long = 'x'.repeat(AGENDA_QUOTE_CHARS + 5);
    should(agendaQuote(long)).equal(`${'x'.repeat(AGENDA_QUOTE_CHARS)}…`);
    should(agendaQuote('short')).equal('short');
  });
});

describe('the agenda chat forms — the same words, read back', () => {
  it('reads an answer and its note', () => {
    should(parseAgendaMessage(agendaAnswerMessage(ask, 'Button only'))).eql({
      parts: [
        {
          kind: 'answer',
          items: [ask],
          text: 'Button only',
          raw: agendaAnswerMessage(ask, 'Button only'),
        },
      ],
    });
    const noted = parseAgendaMessage(agendaAnswerMessage(other, 'Yes', 'today'))?.parts[0];
    should(noted?.text).equal('Yes');
    should(noted?.note).equal('today');
  });

  it('reads the owner note out of a discussion, and an empty one when there was none', () => {
    should(parseAgendaMessage(agendaDiscussMessage(other, 'why now? Reply soon.', 'fy'))?.parts[0]?.text).equal(
      'why now? Reply soon.',
    );
    should(parseAgendaMessage(agendaDiscussMessage(other, '', 'fy'))?.parts[0]?.text).equal('');
    should(parseAgendaMessage(`[discuss !A7 «Ship it?»] an older wording`)?.parts[0]?.text).equal('an older wording');
    should(
      parseAgendaMessage(`[discuss !A7 «Ship it?»] The owner wants to talk this through before answering: cut short`)
        ?.parts[0]?.text,
    ).equal('cut short');
  });

  it("reads the owner's own words out of a done, a dismiss and a request for information", () => {
    should(parseAgendaMessage(agendaDoneMessage(other))?.parts[0]).containDeep({ kind: 'done', text: '' });
    should(parseAgendaMessage('[done !A7 «Ship it?»] an older wording')?.parts[0]?.text).equal('an older wording');
    should(parseAgendaMessage(agendaDismissedMessage(other, 'stale'))?.parts[0]).containDeep({
      kind: 'dismissed',
      text: 'stale',
    });
    should(parseAgendaMessage(agendaDismissedMessage(other))?.parts[0]?.text).equal('');
    should(parseAgendaMessage('[dismissed !A7 «Ship it?»] gone')?.parts[0]?.text).equal('gone');
    should(parseAgendaMessage(agendaNeedsInfoMessage(other))?.parts[0]?.text).equal('');
    should(parseAgendaMessage(agendaNeedsInfoMessage(other, 'which?'))?.parts[0]).containDeep({
      kind: 'needs-info',
      text: 'which?',
    });
  });

  it('reads every item a reply names, and a reply with no words of its own', () => {
    should(parseAgendaMessage(agendaReMessage([ask, other], 'both?'))?.parts[0]).containDeep({
      kind: 're',
      items: [ask, other],
      text: 'both?',
    });
    should(parseAgendaMessage(agendaReMessage([other], ''))?.parts[0]?.text).equal('');
  });

  it('reads an ask that itself holds the closing quote mark', () => {
    const odd = { id: 'A3', quote: 'Use «this» or «that»?' };
    should(parseAgendaMessage(agendaReMessage([odd, other], 'hm'))?.parts[0]?.items).eql([odd, other]);
    should(parseAgendaMessage(agendaAnswerMessage(odd, 'this'))?.parts[0]?.items).eql([odd]);
  });

  it('reads a batch form by form, keeping a multi-paragraph answer whole', () => {
    const message = agendaBatchMessage([
      agendaAnswerMessage(ask, 'first\n\nsecond paragraph'),
      agendaDoneMessage(other),
    ]);
    const parts = parseAgendaMessage(message)?.parts ?? [];
    should(parts.map(part => part.kind)).eql(['answer', 'done']);
    should(parts[0]?.text).equal('first\n\nsecond paragraph');
  });

  it('is not an agenda message unless every form reads', () => {
    should(parseAgendaMessage('hello')).be.undefined();
    should(parseAgendaMessage('[answer to !A0 «x»] y')).be.undefined();
    should(parseAgendaMessage('[answer to !a3 «x»] y')).be.undefined();
    should(parseAgendaMessage('[answer to !A3 «x»]y')).be.undefined();
    should(parseAgendaMessage('[answer to !A3 «x», !A4 «y»] both')).be.undefined();
    should(parseAgendaMessage('see [re !A3 «x»] later')).be.undefined();
    should(parseAgendaMessage(`a note of mine\n\n${agendaDoneMessage(other)}`)).be.undefined();
  });
});
