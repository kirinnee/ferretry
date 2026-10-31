import { describe, expect, test } from 'bun:test';
import { hasAgendaBrief, swipeMap, visibleWhy } from '../../src/lib/agenda-inbox.ts';

describe('structured-item rules', () => {
  test('hides why when it only repeats the summary', () => {
    expect(visibleWhy({ subject: 'Pick one', why: '  Pick one ' })).toBeNull();
    expect(visibleWhy({ subject: 'Pick one', why: 'Because it blocks the build.' })).toBe(
      'Because it blocks the build.',
    );
  });

  test('knows a rich item from an old one', () => {
    expect(hasAgendaBrief({})).toBe(false);
    expect(hasAgendaBrief({ impact: 'it stalls' })).toBe(true);
    expect(hasAgendaBrief({ premise: '- a fact' })).toBe(true);
    expect(hasAgendaBrief({ decided: '- a decision' })).toBe(true);
  });

  test('swipes the options of one question, and nothing on several questions: the reply answers those', () => {
    const ask = { kind: 'multiple-choice' as const, options: [{ label: 'One' }, { label: 'Two' }] };
    const one = swipeMap({ subject: 'Pick', ask, questions: [{ question: 'a' }] });
    expect(Object.keys(one).sort()).toEqual(['left', 'right']);
    expect(one.left).toMatchObject({ kind: 'respond', label: 'One' });
    expect(one.right).toMatchObject({ kind: 'respond', label: 'Two' });
    expect(swipeMap({ subject: 'Pick', ask, questions: [{ question: 'a' }, { question: 'b' }] })).toEqual({});
    expect(
      swipeMap({
        subject: 'Tell me',
        ask: { kind: 'open-question' },
        questions: [{ question: 'a' }, { question: 'b' }],
      }),
    ).toEqual({});
  });
});
