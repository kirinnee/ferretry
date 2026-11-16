import { describe, expect, test } from 'bun:test';
import type { Question } from '../../../../contract/index.ts';
import type { Instant } from '@ferretry/std';
import { agendaAnswers } from '../../../../daemon/questions/lib/agenda-answer.ts';

const option = (label: string) => ({ label });
/** A tabbed form: pick one, pick many, then a free-text question (no options). */
const FORM: Question = {
  format: 1,
  toolUseId: 't1',
  header: 'Mode',
  text: 'Which mode?',
  options: [option('Fast'), option('Slow')],
  multiple: false,
  more: [
    {
      header: 'Channels',
      text: 'Which channels?',
      options: [option('Mail'), option('Page'), option('A, B')],
      multiple: true,
    },
    { header: 'Why', text: 'Why?', options: [], multiple: false },
  ],
  askedAt: '2026-11-14T01:00:00.000Z' as Instant,
};
const SINGLE: Question = { ...FORM, more: undefined };

describe('an Agenda answer, as the answers the question form is driven with', () => {
  test("a form answer maps field N to question N: a pick, several picks and the owner's own words", () => {
    const mapped = agendaAnswers(FORM, { values: { '1': 'Fast', '2': 'Mail, Page', '3': 'Because it is useful' } });

    expect(mapped).toEqual({
      ok: true,
      answers: [
        { kind: 'selection', labels: ['Fast'] },
        { kind: 'selection', labels: ['Mail', 'Page'] },
        { kind: 'other', text: 'Because it is useful' },
      ],
    });
  });

  test('a label that itself holds a comma is read whole, and words the options do not account for stay words', () => {
    expect(agendaAnswers(FORM, { values: { '1': 'Fast', '2': 'A, B, Mail', '3': 'x' } })).toMatchObject({
      ok: true,
      answers: [{}, { kind: 'selection', labels: ['A, B', 'Mail'] }, {}],
    });
    expect(agendaAnswers(FORM, { values: { '1': 'Medium', '2': 'Mail, Fax', '3': 'x' } })).toMatchObject({
      ok: true,
      answers: [{ kind: 'other', text: 'Medium' }, { kind: 'other', text: 'Mail, Fax' }, {}],
    });
  });

  test('a question the owner left blank is answered skipped, so the form still goes in one go', () => {
    expect(agendaAnswers(FORM, { values: { '1': 'Slow' } })).toEqual({
      ok: true,
      answers: [
        { kind: 'selection', labels: ['Slow'] },
        { kind: 'other', text: 'skipped' },
        { kind: 'other', text: 'skipped' },
      ],
    });
  });

  test('a field the question does not have is refused, not dropped', () => {
    expect(agendaAnswers(FORM, { values: { '1': 'Fast', '9': 'x' } })).toEqual({
      ok: false,
      reason: 'the answer names a field (9) the question does not have',
    });
  });

  test('a reply (a card that could not be a form) answers one question directly', () => {
    expect(agendaAnswers(SINGLE, { text: ' Slow ' })).toEqual({
      ok: true,
      answers: [{ kind: 'selection', labels: ['Slow'] }],
    });
    expect(agendaAnswers(SINGLE, { text: 'neither' })).toEqual({
      ok: true,
      answers: [{ kind: 'other', text: 'neither' }],
    });
  });

  test('a reply to several questions must number its answers, and an unnumbered one is refused', () => {
    expect(agendaAnswers(FORM, { text: '1. Fast\n2. Mail, Page\n3. Because\nit helps' })).toEqual({
      ok: true,
      answers: [
        { kind: 'selection', labels: ['Fast'] },
        { kind: 'selection', labels: ['Mail', 'Page'] },
        { kind: 'other', text: 'Because\nit helps' },
      ],
    });
    expect(agendaAnswers(FORM, { text: 'Fast and mail' })).toMatchObject({ ok: false });
    expect(agendaAnswers(FORM, { text: '2. a\n1. b' })).toMatchObject({ ok: false });
  });
});
