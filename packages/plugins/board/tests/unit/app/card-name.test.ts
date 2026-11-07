import { describe, expect, it } from 'bun:test';
import { parseWorkName, workIsRedundant } from '../../../app/lib/card-name.ts';

describe('parseWorkName', () => {
  it('splits a bracketed teammate prefix off the task', () => {
    expect(parseWorkName('[Hayden] Fix the scroller')).toEqual({ prefix: 'Hayden', task: 'Fix the scroller' });
  });

  it('leaves an unbracketed name entirely alone', () => {
    expect(parseWorkName('Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
  });

  it('promotes a lone bracket to the task rather than showing a prefix with nothing beside it', () => {
    expect(parseWorkName('[Hayden]')).toEqual({ prefix: null, task: 'Hayden' });
  });

  it('keeps the whole string when the bracket is empty of anything but spaces', () => {
    expect(parseWorkName('[   ]')).toEqual({ prefix: null, task: '[   ]' });
  });

  it('drops an empty prefix while keeping the task after it', () => {
    expect(parseWorkName('[ ] Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
  });

  it('treats a bracket in the middle as prose', () => {
    expect(parseWorkName('fix [Hayden] later')).toEqual({ prefix: null, task: 'fix [Hayden] later' });
  });

  it('answers with an empty task for a missing or blank name', () => {
    expect(parseWorkName(undefined)).toEqual({ prefix: null, task: '' });
    expect(parseWorkName(null)).toEqual({ prefix: null, task: '' });
    expect(parseWorkName('   ')).toEqual({ prefix: null, task: '' });
  });

  it('spans a task that runs onto another line', () => {
    expect(parseWorkName('[Hayden] Fix the\nscroller')).toEqual({ prefix: 'Hayden', task: 'Fix the\nscroller' });
  });
});

describe('workIsRedundant', () => {
  it('calls an absent task redundant, because there is nothing to add', () => {
    expect(workIsRedundant(undefined, 'hayden')).toBe(true);
  });

  it('calls a task that only repeats the callsign redundant, whatever its casing', () => {
    expect(workIsRedundant('[Hayden]', 'hayden')).toBe(true);
    expect(workIsRedundant('hayden', '  Hayden  ')).toBe(true);
  });

  it('keeps a task that says something the callsign did not', () => {
    expect(workIsRedundant('[Hayden] Fix the scroller', 'hayden')).toBe(false);
  });

  it('keeps a task when there is no callsign to repeat', () => {
    expect(workIsRedundant('Fix the scroller', undefined)).toBe(false);
  });
});
