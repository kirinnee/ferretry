import { describe, expect, it } from 'bun:test';
import { parseTaskName, taskIsRedundant } from '../../src/shell/task-name.ts';

describe('parseTaskName', () => {
  it('splits a bracketed teammate prefix off the task', () => {
    expect(parseTaskName('[Hayden] Fix the scroller')).toEqual({ prefix: 'Hayden', task: 'Fix the scroller' });
  });

  it('leaves an unbracketed name entirely alone', () => {
    expect(parseTaskName('Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
  });

  it('promotes a lone bracket to the task rather than showing a prefix with nothing beside it', () => {
    expect(parseTaskName('[Hayden]')).toEqual({ prefix: null, task: 'Hayden' });
  });

  it('keeps the whole string when the bracket is empty of anything but spaces', () => {
    expect(parseTaskName('[   ]')).toEqual({ prefix: null, task: '[   ]' });
  });

  it('drops an empty prefix while keeping the task after it', () => {
    expect(parseTaskName('[ ] Fix the scroller')).toEqual({ prefix: null, task: 'Fix the scroller' });
  });

  it('treats a bracket in the middle as prose', () => {
    expect(parseTaskName('fix [Hayden] later')).toEqual({ prefix: null, task: 'fix [Hayden] later' });
  });

  it('answers with an empty task for a missing or blank name', () => {
    expect(parseTaskName(undefined)).toEqual({ prefix: null, task: '' });
    expect(parseTaskName(null)).toEqual({ prefix: null, task: '' });
    expect(parseTaskName('   ')).toEqual({ prefix: null, task: '' });
  });

  it('spans a task that runs onto another line', () => {
    expect(parseTaskName('[Hayden] Fix the\nscroller')).toEqual({ prefix: 'Hayden', task: 'Fix the\nscroller' });
  });
});

describe('taskIsRedundant', () => {
  it('calls an absent task redundant, because there is nothing to add', () => {
    expect(taskIsRedundant(undefined, 'hayden')).toBe(true);
  });

  it('calls a task that only repeats the callsign redundant, whatever its casing', () => {
    expect(taskIsRedundant('[Hayden]', 'hayden')).toBe(true);
    expect(taskIsRedundant('hayden', '  Hayden  ')).toBe(true);
  });

  it('keeps a task that says something the callsign did not', () => {
    expect(taskIsRedundant('[Hayden] Fix the scroller', 'hayden')).toBe(false);
  });

  it('keeps a task when there is no callsign to repeat', () => {
    expect(taskIsRedundant('Fix the scroller', undefined)).toBe(false);
  });
});
