import { describe, expect, test } from 'bun:test';
import {
  allAnswered,
  answered,
  answerText,
  initialAnswers,
  questionKeys,
  selectOther,
  toggleOption,
  updateOther,
} from '../../src/components/question-form-model.ts';

describe('question answers', () => {
  test('start empty and become answered by a pick or by typed Other text', () => {
    const empty = initialAnswers(2);
    expect(allAnswered(empty, 2)).toBe(false);
    const picked = toggleOption(empty, 0, 'A', false);
    expect(answered(picked, 0)).toBe(true);
    expect(answerText(picked, 0)).toBe('A');
    expect(answerText(picked, 1)).toBeNull();
    const other = selectOther(picked, 1);
    expect(answered(other, 1)).toBe(false);
    const typed = updateOther(other, 1, '  hello ');
    expect(answerText(typed, 1)).toBe('hello');
    expect(allAnswered(typed, 2)).toBe(true);
  });

  test('a single-select pick replaces the last one, and a multi-select toggles', () => {
    const one = toggleOption(toggleOption(initialAnswers(1), 0, 'A', false), 0, 'B', false);
    expect(one.picks[0]).toEqual(['B']);
    const many = toggleOption(toggleOption(toggleOption(initialAnswers(1), 0, 'A', true), 0, 'B', true), 0, 'A', true);
    expect(many.picks[0]).toEqual(['B']);
    expect(answerText(toggleOption(many, 0, 'C', true), 0)).toBe('B, C');
  });

  test('choosing an option clears Other, and choosing Other clears the options', () => {
    const typed = updateOther(selectOther(toggleOption(initialAnswers(1), 0, 'A', false), 0), 0, 'x');
    expect(typed.picks[0]).toEqual([]);
    expect(typed.otherSelected[0]).toBe(true);
    const back = toggleOption(typed, 0, 'A', false);
    expect(back.otherSelected[0]).toBe(false);
    expect(answerText(back, 0)).toBe('A');
  });
});

describe('questionKeys', () => {
  test('numbers a repeated question so every key stays unique', () => {
    const keys = questionKeys('t', ['Same?', 'Other?', 'Same?']);
    expect(keys).toEqual(['t:Same?:1', 't:Other?:1', 't:Same?:2']);
  });
});
