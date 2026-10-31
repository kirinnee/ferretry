import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaFormFieldSchema,
  AgendaItemSchema,
  AgendaResponseSchema,
  agendaFormProblems,
  type AgendaFormField,
} from '../../src/lib/agenda.ts';
import { agendaCardAnswers, agendaShape } from '../../src/lib/agenda-card.ts';
import {
  formAnswerProblems,
  formFieldName,
  formFieldRequired,
  formMissing,
  formWords,
} from '../../src/lib/agenda-form.ts';
import { AGENDA_SHAPE_LINE, agendaShapeProblems } from '../../src/lib/agenda-shape.ts';

const region: AgendaFormField = {
  id: '1',
  type: 'one',
  label: 'Which region?',
  options: [{ label: 'EU', description: 'Data stays in Europe' }, { label: 'US' }],
  recommended: ['EU'],
};
const alerts: AgendaFormField = {
  id: '2',
  type: 'many',
  label: 'Which alerts?',
  name: 'Alerts',
  options: [{ label: 'Failures' }, { label: 'Slow builds' }],
};
const restart: AgendaFormField = { id: '3', type: 'yesno', label: 'OK to restart?' };
const notes: AgendaFormField = { id: '4', type: 'text', label: 'Anything else?' };
const FIELDS = [region, alerts, restart, notes];

const ITEM = {
  id: 'A7',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Deploy settings',
  why: 'The deploy waits on them',
  waitingSince: '2026-10-30T09:00:00.000Z',
  howToResolve: 'Fill in the form',
  raisedBy: 'agent',
  raisedBySession: 's1',
  raisedByName: null,
  kind: 'form',
  ask: { kind: 'open-question' },
  fields: FIELDS,
} as const;

describe('a form card on the agenda', () => {
  it('should be an item of kind form that carries its fields and is asked as an open question', () => {
    should(AgendaItemSchema.safeParse(ITEM).success).be.true();
    should(agendaShape(ITEM)).equal('form');
  });

  it('should refuse a form without fields, and fields on any other kind', () => {
    const { fields: _fields, ...bare } = ITEM;

    should(AgendaItemSchema.safeParse(bare).success).be.false();
    should(agendaFormProblems(bare)).have.length(1);
    should(AgendaItemSchema.safeParse({ ...ITEM, kind: 'reply' }).success).be.false();
  });

  it('should refuse repeated ids and more than one text field', () => {
    should(agendaFormProblems({ kind: 'form', fields: [region, { ...restart, id: '1' }] })).have.length(1);
    should(agendaFormProblems({ kind: 'form', fields: [notes, { ...notes, id: '5' }] })).have.length(1);
  });

  it('should offer no swipe answers', () => {
    should(agendaCardAnswers(ITEM)).deepEqual([]);
  });

  it('should refuse options on a yes/no or text field, and a pick without them', () => {
    const options = [{ label: 'A' }, { label: 'B' }];

    should(AgendaFormFieldSchema.safeParse({ ...restart, options }).success).be.false();
    should(AgendaFormFieldSchema.safeParse({ ...notes, options }).success).be.false();
    should(AgendaFormFieldSchema.safeParse({ id: '9', type: 'one', label: 'Which?' }).success).be.false();
  });

  it('should refuse a recommendation that is not an option, or several on a pick-one', () => {
    should(AgendaFormFieldSchema.safeParse({ ...region, recommended: ['Asia'] }).success).be.false();
    should(AgendaFormFieldSchema.safeParse({ ...region, recommended: ['EU', 'US'] }).success).be.false();
    should(AgendaFormFieldSchema.safeParse({ ...alerts, recommended: ['Failures', 'Slow builds'] }).success).be.true();
    should(AgendaFormFieldSchema.safeParse({ ...restart, recommended: ['Yes'] }).success).be.true();
  });

  it('should take a structured answer by field id', () => {
    const answer = {
      kind: 'form',
      answers: [
        { id: '1', picked: 'EU' },
        { id: '2', picked: ['Failures'] },
      ],
    };

    should(AgendaResponseSchema.safeParse(answer).success).be.true();
    should(AgendaResponseSchema.safeParse({ kind: 'form', answers: [] }).success).be.false();
  });

  it('should name the form kind in the instruction line', () => {
    should(AGENDA_SHAPE_LINE).containEql('form=');
    should(AGENDA_SHAPE_LINE).containEql('--field');
  });

  it('should ask the ferret for fields when it raises a form without them', () => {
    should(agendaShapeProblems({ kind: 'form' }).length).be.above(0);
    should(agendaShapeProblems({ kind: 'form', fields: FIELDS })).deepEqual([]);
  });
});

describe('a filled-in form', () => {
  const answers = [
    { id: '1', picked: 'EU' },
    { id: '2', picked: ['Failures', 'Slow builds'] },
    { id: '3', picked: 'Yes' },
    { id: '4', picked: 'Ship after 6pm' },
  ];

  it('should read as numbered lines in the form’s order', () => {
    should(formWords(FIELDS, answers)).equal(
      '1. Which region: EU\n2. Alerts: Failures, Slow builds\n3. OK to restart: Yes\n4. Anything else: Ship after 6pm',
    );
    should(formWords(FIELDS, answers.slice(0, 1), ' · ')).equal(
      '1. Which region: EU · 2. Alerts: (no answer) · 3. OK to restart: (no answer) · 4. Anything else: (no answer)',
    );
  });

  it('should name a field by its own name, else its question without the closing mark', () => {
    should(formFieldName(alerts)).equal('Alerts');
    should(formFieldName(region)).equal('Which region');
  });

  it('should require every field but the text one, unless it says otherwise', () => {
    should(formFieldRequired(region)).be.true();
    should(formFieldRequired(notes)).be.false();
    should(formFieldRequired({ ...restart, required: false })).be.false();
  });

  it('should list the required fields left empty', () => {
    should(formMissing(FIELDS, answers.slice(0, 1)).map(field => field.id)).deepEqual(['2', '3']);
    should(formMissing(FIELDS, answers)).deepEqual([]);
  });

  it('should accept answers that fit and name each problem when they do not', () => {
    should(formAnswerProblems(FIELDS, answers)).deepEqual([]);
    should(formAnswerProblems(FIELDS, [{ id: '9', picked: 'x' }])[0]).containEql('no field "9"');
    should(formAnswerProblems(FIELDS, [{ id: '1', picked: 'Asia' }])[0]).containEql('not an option');
    should(formAnswerProblems(FIELDS, [{ id: '1', picked: ['EU', 'US'] }])[0]).containEql('exactly one');
    should(
      formAnswerProblems(FIELDS, [
        { id: '1', picked: 'EU' },
        { id: '1', picked: 'US' },
      ])[0],
    ).containEql('twice');
  });
});

describe('a form never asks for a secret', () => {
  it('should have no field kind that collects a password or secret', () => {
    for (const type of ['secret', 'password', 'token', 'masked']) {
      should(AgendaFormFieldSchema.safeParse({ id: 's', type, label: 'Your password?' }).success).equal(false);
    }
  });

  it('should keep a form answer to the field id and what was picked or typed', () => {
    should(AgendaResponseSchema.safeParse({ kind: 'form', answers: [{ id: '1', value: 'EU' }] }).success).equal(false);
    should(
      AgendaResponseSchema.safeParse({ kind: 'form', answers: [{ id: '1', picked: 'EU', secret: 'x' }] }).success,
    ).equal(false);
  });
});
