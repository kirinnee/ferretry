import { describe, expect, test } from 'bun:test';
import { ferretLabel, ferretTask, ferretTitles } from '../../../../app/lib/ferret-title.ts';
import { ferretSummary } from './support.ts';

const named = (over: Parameters<typeof ferretSummary>[1]) => ferretSummary('abc123', over);

describe('what a ferret row is titled', () => {
  test('a titled ferret is titled by its task, the ferret second', () => {
    expect(ferretTitles(named({ title: 'Diene Work' }))).toEqual({ title: 'Diene Work', ferret: 'Hadi' });
  });

  test('a ferret with no task is titled by its folder, the ferret second', () => {
    expect(ferretTitles(named({}))).toEqual({ title: 'home-manager', ferret: 'Hadi' });
    expect(ferretTask(named({ title: undefined }))).toBe('');
  });

  test('a title that only repeats the callsign is no task', () => {
    expect(ferretTitles(named({ title: 'Hadi' })).title).toBe('home-manager');
  });

  test('with no folder segment either the callsign titles it, then the id', () => {
    expect(ferretTitles(named({ folder: '/' }))).toEqual({ title: 'Hadi', ferret: null });
  });

  test('a windows folder titles it by its last segment', () => {
    expect(ferretTitles(named({ folder: 'C:\\work\\home-manager\\' })).title).toBe('home-manager');
  });

  test('the one-line label is the title alone', () => {
    expect(ferretLabel(named({}))).toBe('home-manager');
    expect(ferretLabel(named({ title: 'Diene Work' }))).toBe('Diene Work');
  });
});
