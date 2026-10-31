import { describe, it } from 'bun:test';
import should from 'should';
import { composeAddRequest } from '../../../src/lib/agenda/brief';
import { describeAnswer } from '../../../src/lib/agenda/answer';
import { fieldFromFlag, fieldsFrom } from '../../../src/lib/agenda/fields';

describe('--field', () => {
  it('should read a pick-one with what each option means, and the one recommended', () => {
    should(fieldFromFlag('1|one|Which region?|*EU: data stays in Europe|US: cheapest')).deepEqual({
      id: '1',
      type: 'one',
      label: 'Which region?',
      options: [
        { label: 'EU', description: 'data stays in Europe' },
        { label: 'US', description: 'cheapest' },
      ],
      recommended: ['EU'],
    });
  });

  it('should read a pick-many, a yes/no with a recommendation, and a free-text field', () => {
    should(fieldFromFlag('2|many|Alerts~Which alerts?|Failures|Slow builds')).containDeep({
      type: 'many',
      name: 'Alerts',
      label: 'Which alerts?',
    });
    should(fieldFromFlag('3|yesno|OK to restart?|*No')).deepEqual({
      id: '3',
      type: 'yesno',
      label: 'OK to restart?',
      recommended: 'No',
    });
    should(fieldFromFlag('4|text|Anything else?|optional')).containDeep({ type: 'text', required: false });
  });

  it('should say what is wrong in plain words', () => {
    should(() => fieldsFrom(['1|pick|Which?|A|B'], undefined)).throw(/unknown field type "pick"/u);
    should(() => fieldsFrom(['1|one|Which?|A'], undefined)).throw(/2 or more options/u);
    should(() => fieldsFrom(['1|text|Anything?|A|B'], undefined)).throw(/no options/u);
    should(() => fieldsFrom(['1|one'], undefined)).throw(/needs id\|/u);
  });

  it('should take the JSON body’s fields when no flag is given, and let a flag win', () => {
    const file = [{ id: 1, type: 'yesno', label: 'OK?' }];

    should(fieldsFrom(undefined, file)?.[0]).containDeep({ id: '1', type: 'yesno' });
    should(fieldsFrom(['9|text|Notes?'], file)?.[0]).containDeep({ id: '9', type: 'text' });
    should(fieldsFrom(undefined, undefined)).be.undefined();
  });
});

describe('a form card from the CLI', () => {
  it('should be raised as a form, without a --kind, when it has fields', () => {
    const request = composeAddRequest(
      ['Deploy settings'],
      { title: 'Deploy settings', field: ['1|one|Which region?|EU|US', '2|text|Anything else?'] },
      {},
    );

    should(request).containDeep({ kind: 'form', ask: { kind: 'open-question' } });
    should(request.fields).have.length(2);
  });

  it('should say a filled-in form by its answers', () => {
    const fields = fieldsFrom(['1|one|Which region?|EU|US'], undefined) ?? [];

    should(describeAnswer({ kind: 'form', answers: [{ id: '1', value: 'EU' }] }, fields)).equal(
      'form answered: 1. Which region: EU',
    );
  });
});
