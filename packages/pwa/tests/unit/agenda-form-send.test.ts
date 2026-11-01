import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgendaFormField } from '@ferretry/protocol';
import { AgendaFormStore, agendaForms, recommendedPicks, toggled, withPick } from '../../src/lib/agenda-form-state.ts';
import type { InboxAction } from '../../src/lib/agenda-answers.ts';
import { formAnswersFrom, planFormSend, sendForm, withFormSend } from '../../src/lib/agenda-form-send.ts';

const FIELDS = [
  {
    id: '1',
    type: 'one',
    label: 'Which region?',
    name: 'Region',
    options: [{ label: 'EU', description: 'data stays in Europe' }, { label: 'US' }],
    recommended: ['EU'],
  },
  { id: '2', type: 'many', label: 'Which alerts?', name: 'Alerts', options: [{ label: 'Page' }, { label: 'Mail' }] },
  { id: '3', type: 'yesno', label: 'OK to restart?', name: 'Restart' },
  { id: '4', type: 'text', label: 'Anything else?', required: false },
] as unknown as AgendaFormField[];

const item = { fields: FIELDS };

beforeEach(() => {
  agendaForms.forget('k');
});

describe('form picks', () => {
  test('start on the recommendation, and a pick-one holds one value while a pick-many toggles', () => {
    expect(recommendedPicks(FIELDS)).toEqual({ '1': ['EU'] });
    expect(toggled(['EU'], 'US', false)).toEqual(['US']);
    expect(toggled(['Page'], 'Mail', true)).toEqual(['Page', 'Mail']);
    expect(toggled(['Page', 'Mail'], 'Page', true)).toEqual(['Mail']);
    expect(withPick({ '1': ['EU'] }, '1', [])).toEqual({});
  });

  test('a store keeps picks per key, tells listeners and forgets on send', () => {
    const store = new AgendaFormStore();
    let seen = 0;
    store.subscribe(() => {
      seen += 1;
    });
    expect(store.picks('a', FIELDS)).toEqual({ '1': ['EU'] });
    store.set('a', FIELDS, '1', ['US']);
    expect(store.picks('a', FIELDS)).toEqual({ '1': ['US'] });
    expect(store.picks('b', FIELDS)).toEqual({ '1': ['EU'] });
    store.markAsked('a', '3');
    store.set('a', FIELDS, '3', ['Yes']);
    expect(store.asked('a')).toBeUndefined();
    expect(store.changes('a')).toBe(2);
    expect(store.changes('b')).toBe(0);
    store.forget('a');
    expect(store.changes('a')).toBe(0);
    expect(store.picks('a', FIELDS)).toEqual({ '1': ['EU'] });
    expect(seen).toBeGreaterThanOrEqual(3);
  });
});

describe('planning the one Send of a form', () => {
  test('answers in the form’s order: pick-many as a list, the typed words as the text field', () => {
    const answers = formAnswersFrom(FIELDS, { '1': ['EU'], '2': ['Page', 'Mail'], '3': ['Yes'] }, '  ship it ');
    expect(answers).toEqual([
      { id: '1', picked: 'EU' },
      { id: '2', picked: ['Page', 'Mail'] },
      { id: '3', picked: 'Yes' },
      { id: '4', picked: 'ship it' },
    ]);
  });

  test('a pick-many with something ticked is answered, so the ask never names it', () => {
    const picks = { '1': ['EU'], '2': ['Page', 'Mail'], '3': ['Yes'] };
    const plan = planFormSend(item, picks, '', undefined);
    expect(plan.kind).toBe('send');
    const alone = planFormSend({ fields: [FIELDS[1] as AgendaFormField] }, { '2': ['Mail'] }, '', undefined);
    expect(alone.kind).toBe('send');
    const none = planFormSend(item, { '1': ['EU'], '3': ['Yes'] }, '', undefined);
    if (none.kind !== 'ask') throw new Error('expected an ask');
    expect(none.message).toContain('2. Alerts');
  });

  test('says there is nothing to send when nothing is filled in', () => {
    const plan = planFormSend({ fields: FIELDS.slice(1) }, {}, '', undefined);
    expect(plan).toEqual({ kind: 'nothing', message: 'Fill in at least one field before you send the form.' });
  });

  test('asks once about required fields left empty, then sends as it stands', () => {
    const first = planFormSend(item, { '1': ['EU'] }, '', undefined);
    if (first.kind !== 'ask') throw new Error('expected an ask');
    expect(first.message).toContain('Not answered yet:');
    expect(first.message).toContain('2. Alerts');
    expect(first.message).toContain('Press Send again');
    const second = planFormSend(item, { '1': ['EU'] }, '', first.signature);
    expect(second.kind).toBe('send');
  });

  test('sends a form answer, with the typed words as the note when the form has no text field', () => {
    const plan = planFormSend(
      { fields: FIELDS.slice(0, 3) },
      { '1': ['EU'], '2': ['Page'], '3': ['No'] },
      'also this',
      undefined,
    );
    expect(plan).toEqual({
      kind: 'send',
      action: {
        kind: 'respond',
        label: 'Form',
        response: {
          kind: 'form',
          answers: [
            { id: '1', picked: 'EU' },
            { id: '2', picked: ['Page'] },
            { id: '3', picked: 'No' },
          ],
        },
        note: 'also this',
      },
    });
  });
});

describe('sendForm', () => {
  test('throws the plain sentence once, then schedules the answer and forgets the picks', () => {
    const scheduled: InboxAction[] = [];
    const schedule = (action: InboxAction) => scheduled.push(action);
    expect(() => sendForm('k', item, '', schedule)).toThrow('Not answered yet');
    expect(scheduled).toHaveLength(0);
    sendForm('k', item, '', schedule);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      kind: 'respond',
      response: { kind: 'form', answers: [{ id: '1', picked: 'EU' }] },
    });
    expect(agendaForms.asked('k')).toBeUndefined();
  });

  test('throws when there is nothing to send', () => {
    const scheduled: InboxAction[] = [];
    expect(() => sendForm('k', { fields: [FIELDS[3] as AgendaFormField] }, '  ', a => scheduled.push(a))).toThrow(
      'Fill in at least one field',
    );
    expect(scheduled).toHaveLength(0);
  });
});

describe('withFormSend', () => {
  test('replaces send with the form’s answer and leaves the other methods alone', async () => {
    const chat = { send: (_text: string) => 'chat', other: () => 'other' };
    let answered = 0;
    const wrapped = withFormSend(chat, () => {
      answered += 1;
    });
    await wrapped.send('hello');
    expect(answered).toBe(1);
    expect(wrapped.other()).toBe('other');
  });

  test('lets the form’s one error line through the composer’s send', () => {
    const wrapped = withFormSend({ send: (_text: string) => 'chat' }, () => {
      throw new Error('Not answered yet');
    });
    expect(() => wrapped.send('x')).toThrow('Not answered yet');
  });
});
