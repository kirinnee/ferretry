import { describe, expect, test } from 'bun:test';
import { sessionLabel, sessionTask, sessionTitles } from '../../src/shell/session-title.ts';

const config = (over: Partial<{ name: string; cwd: string; teammate: string; id: string }>) => ({
  id: 'abc123',
  name: 'interactive',
  cwd: '/home/kirin/Workspace/liftoff/home-manager',
  teammate: 'hadi',
  ...over,
});

describe('what a session row is titled', () => {
  test('a named session is titled by its task, the ferret second', () => {
    expect(sessionTitles(config({ name: 'Diene Work' }))).toEqual({ title: 'Diene Work', ferret: 'Hadi' });
  });

  test('a bracketed callsign prefix is dropped from the task', () => {
    expect(sessionTask('[Hadi] Fix the scroller')).toBe('Fix the scroller');
  });

  test('the mode word is never a title: an unnamed session is titled by its folder, the ferret second', () => {
    expect(sessionTitles(config({ name: 'interactive' }))).toEqual({ title: 'home-manager', ferret: 'Hadi' });
    expect(sessionTitles(config({ name: ' Interactive ' }))).toEqual({ title: 'home-manager', ferret: 'Hadi' });
    expect(sessionTask('interactive')).toBe('');
  });

  test('a name that only repeats the callsign is no task', () => {
    expect(sessionTitles(config({ name: 'Hadi' })).title).toBe('home-manager');
  });

  test('with no folder either the callsign titles it, then the id', () => {
    expect(sessionTitles(config({ name: 'interactive', cwd: '' }))).toEqual({ title: 'Hadi', ferret: null });
    expect(sessionTitles(config({ name: 'interactive', cwd: '', teammate: undefined }))).toEqual({
      title: 'abc123',
      ferret: null,
    });
  });

  test('a folder with no callsign has no second name', () => {
    expect(sessionTitles(config({ name: '  ', teammate: undefined }))).toEqual({ title: 'home-manager', ferret: null });
  });

  test('the one-line label is the title alone', () => {
    expect(sessionLabel(config({ name: 'interactive' }))).toBe('home-manager');
    expect(sessionLabel(config({ name: 'Diene Work' }))).toBe('Diene Work');
  });
});
