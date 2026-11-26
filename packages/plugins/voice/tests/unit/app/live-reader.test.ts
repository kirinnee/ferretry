import { describe, expect, test } from 'bun:test';
import { createLiveReader, type LiveRow } from '../../../app/lib/voice-mode/live-reader.ts';

/**
 * Which `<voice>` lines of a streaming reply are new, and what each is for. Pure: no clock, no browser.
 */

const person = (id = 'u1', text = '(voice) check the build'): LiveRow => ({ id, kind: 'user', text });
const ferret = (text: string, id = 'a1'): LiveRow => ({ id, kind: 'assistant', text });
const LIVE = { live: true, working: true, visible: true } as const;

describe('the reader of finished voice lines', () => {
  test('the first look only learns what is there: history is never said', () => {
    const reader = createLiveReader();
    const history = [person('u0'), ferret('<voice>Old news.</voice>', 'a0')];
    expect(reader.observe(history, LIVE)).toEqual([]);
    expect(reader.observe(history, LIVE)).toEqual([]);
  });

  test('a copy the daemon has not confirmed is looked at in silence, and the first live look is then a first look', () => {
    const reader = createLiveReader();
    const rows = [person(), ferret('<voice>Cached.</voice>')];
    expect(reader.observe(rows, { ...LIVE, live: false })).toEqual([]);
    expect(reader.observe(rows, LIVE)).toEqual([]);
  });

  test('lines arrive in order as they close: the first, then progress while the turn works, then the result', () => {
    const reader = createLiveReader();
    expect(reader.observe([person('u0')], LIVE)).toEqual([]);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('<voice>On it.</voice>')], LIVE)).toEqual([
      { text: 'On it.', kind: 'first' },
    ]);
    // The same text again says nothing more.
    expect(reader.observe([person('u0'), ask, ferret('<voice>On it.</voice>')], LIVE)).toEqual([]);
    const grown = ferret('<voice>On it.</voice>\n\nRan the tests.\n\n<voice>Tests are running.</voice>');
    expect(reader.observe([person('u0'), ask, grown], LIVE)).toEqual([
      { text: 'Tests are running.', kind: 'progress' },
    ]);
    const done = ferret('<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All green.</voice>');
    expect(reader.observe([person('u0'), ask, done], { ...LIVE, working: false })).toEqual([
      { text: 'All green.', kind: 'result' },
    ]);
  });

  test('a line still being written (no closing tag) is not said until it closes', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sen')], LIVE)).toEqual([]);
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sentence.</voice>')], LIVE)).toEqual([
      { text: 'Half a sentence.', kind: 'first' },
    ]);
  });

  test('a new message from the person starts a new turn: its first line is first again', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const one = [person('u1'), ferret('<voice>One.</voice>', 'a1')];
    expect(reader.observe(one, LIVE)).toEqual([{ text: 'One.', kind: 'first' }]);
    const two = [...one, person('u2'), ferret('<voice>Two.</voice>', 'a2')];
    expect(reader.observe(two, LIVE)).toEqual([{ text: 'Two.', kind: 'first' }]);
  });

  test('code that teaches the tag, and a tab nobody is looking at, are never said', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.')], LIVE)).toEqual([]);
    expect(
      reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.\n\n<voice>Hidden.</voice>')], {
        ...LIVE,
        visible: false,
      }),
    ).toEqual([]);
    // Consumed in silence: it is not said on return either.
    expect(
      reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.\n\n<voice>Hidden.</voice>')], LIVE),
    ).toEqual([]);
  });

  test('covers: true only for text with spoken lines that were ALL taken by the voice', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const text = '<voice>On it.</voice>\n\n<voice>All green.</voice>';
    expect(reader.covers(text)).toBe(false);
    reader.accepted('On it.');
    expect(reader.covers(text)).toBe(false);
    reader.accepted('All green.');
    expect(reader.covers(text)).toBe(true);
    expect(reader.covers('No spoken lines here.')).toBe(false);
    expect(reader.covers('')).toBe(false);
  });

  test('reset forgets everything: the next look is a first look', () => {
    const reader = createLiveReader();
    const rows = [person(), ferret('<voice>Hello.</voice>')];
    reader.observe([person()], LIVE);
    expect(reader.observe(rows, LIVE)).toHaveLength(1);
    reader.accepted('Hello.');
    reader.reset();
    expect(reader.covers('<voice>Hello.</voice>')).toBe(false);
    expect(reader.observe(rows, LIVE)).toEqual([]);
  });
});
