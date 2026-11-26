import { describe, expect, test } from 'bun:test';
import { createLiveReader, type LiveRow } from '../../../app/lib/voice-mode/live-reader.ts';

/**
 * Which `<voice>` lines of a streaming reply are new, which are KNOWN to be progress, and what became of each. Pure: no clock,
 * no browser.
 */

const person = (id = 'u1', text = '(voice) check the build'): LiveRow => ({ id, kind: 'user', text });
const ferret = (text: string, id = 'a1'): LiveRow => ({ id, kind: 'assistant', text });
const tool = (id = 't1'): LiveRow => ({ id, kind: 'tool', text: 'ran a command' });
const LIVE = { live: true, visible: true } as const;

describe('the reader of finished voice lines', () => {
  test('the first look only learns what is there: history is never said', () => {
    const reader = createLiveReader();
    const history = [person('u0'), ferret('<voice>Old news.</voice>', 'a0')];
    expect(reader.observe(history, LIVE).lines).toEqual([]);
    expect(reader.observe(history, LIVE).lines).toEqual([]);
  });

  test('a copy the daemon has not confirmed is looked at in silence, and the first live look is then a first look', () => {
    const reader = createLiveReader();
    const rows = [person(), ferret('<voice>Cached.</voice>')];
    expect(reader.observe(rows, { ...LIVE, live: false }).lines).toEqual([]);
    expect(reader.observe(rows, LIVE).lines).toEqual([]);
  });

  test('lines arrive in order as they close: the first of the turn, then the rest as plain lines', () => {
    const reader = createLiveReader();
    expect(reader.observe([person('u0')], LIVE).lines).toEqual([]);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('<voice>On it.</voice>')], LIVE).lines).toEqual([
      { text: 'On it.', kind: 'first' },
    ]);
    // The same text again says nothing more.
    expect(reader.observe([person('u0'), ask, ferret('<voice>On it.</voice>')], LIVE).lines).toEqual([]);
    const grown = ferret('<voice>On it.</voice>\n\nRan the tests.\n\n<voice>Tests are running.</voice>');
    expect(reader.observe([person('u0'), ask, grown], LIVE).lines).toEqual([
      { text: 'Tests are running.', kind: 'line' },
    ]);
    const done = ferret('<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All green.</voice>');
    expect(reader.observe([person('u0'), ask, done], LIVE).lines).toEqual([{ text: 'All green.', kind: 'line' }]);
  });

  test('a line still being written (no closing tag) is not said until it closes', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sen')], LIVE).lines).toEqual([]);
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sentence.</voice>')], LIVE).lines).toEqual([
      { text: 'Half a sentence.', kind: 'first' },
    ]);
  });

  test('a new message from the person starts a new turn: its first line is first again', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const one = [person('u1'), ferret('<voice>One.</voice>', 'a1')];
    expect(reader.observe(one, LIVE).lines).toEqual([{ text: 'One.', kind: 'first' }]);
    const two = [...one, person('u2'), ferret('<voice>Two.</voice>', 'a2')];
    expect(reader.observe(two, LIVE).lines).toEqual([{ text: 'Two.', kind: 'first' }]);
  });

  test('code that teaches the tag, and a tab nobody is looking at, are never said', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.')], LIVE).lines).toEqual([]);
    expect(
      reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.\n\n<voice>Hidden.</voice>')], {
        ...LIVE,
        visible: false,
      }).lines,
    ).toEqual([]);
    // Consumed in silence: it is not said on return either.
    expect(
      reader.observe([person('u0'), ask, ferret('Use `<voice>hi</voice>` like so.\n\n<voice>Hidden.</voice>')], LIVE)
        .lines,
    ).toEqual([]);
  });
});

describe('which lines are KNOWN to be progress', () => {
  const begin = () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    return reader;
  };

  test('words the ferret worked past (a tool call came after them) are progress, once', () => {
    const reader = begin();
    const ask = person('u1');
    const narration = ferret('<voice>Reading the logs.</voice>', 'a1');
    // Said, and not progress yet: the turn may still end on it.
    expect(reader.observe([person('u0'), ask, narration], LIVE).progress).toEqual([]);
    expect(reader.observe([person('u0'), ask, narration, tool()], LIVE).progress).toEqual(['Reading the logs.']);
    expect(reader.observe([person('u0'), ask, narration, tool()], LIVE).progress).toEqual([]);
  });

  test('the lines of the last message are never progress, however many there are', () => {
    const reader = begin();
    const ask = person('u1');
    const result = ferret('<voice>First part.</voice>\n\n<voice>Second part.</voice>', 'a2');
    const looked = reader.observe([person('u0'), ask, tool(), result], LIVE);
    expect(looked.lines.map(line => line.text)).toEqual(['First part.', 'Second part.']);
    expect(looked.progress).toEqual([]);
  });

  test('a message from before the next turn is not progress of that turn, and a tool of the next turn is not evidence about it', () => {
    const reader = begin();
    const ask = person('u1');
    const result = ferret('<voice>All green.</voice>', 'a1');
    expect(reader.observe([person('u0'), ask, result], LIVE).progress).toEqual([]);
    const next = person('u2');
    const rows = [person('u0'), ask, result, next, tool('t9'), ferret('<voice>Next one.</voice>', 'a2')];
    const looked = reader.observe(rows, LIVE);
    expect(looked.progress).toEqual([]);
  });

  test('a tool a turn ago says nothing about words after it', () => {
    const reader = begin();
    const ask = person('u1');
    const looked = reader.observe([person('u0'), ask, tool(), ferret('<voice>Done.</voice>', 'a2')], LIVE);
    expect(looked.progress).toEqual([]);
  });
});

describe('what the end-of-turn reading still has to say', () => {
  const text = '<voice>On it.</voice>\n\n<voice>All green.</voice>';

  test('text nothing of which was said live is read as it stands', () => {
    const reader = createLiveReader();
    expect(reader.unsaid(text)).toBe(text);
    expect(reader.unsaid('No spoken lines here.')).toBe('No spoken lines here.');
    expect(reader.unsaid('')).toBe('');
  });

  test('a line being said, or played, is not said again; when all of them were, nothing is', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const first = reader.accepted('On it.');
    reader.accepted('All green.');
    expect(reader.unsaid(text)).toBe('');
    first('played');
    expect(reader.unsaid(text)).toBe('');
  });

  test('a line that was not played (it failed, was talked over or the stream went) is read, and only that one', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    reader.accepted('On it.')('played');
    reader.accepted('All green.')('unplayed');
    expect(reader.unsaid(text)).toBe('<voice>All green.</voice>');
  });

  test('a line dropped on purpose is never read again, a line never handed over is', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    reader.accepted('On it.')('dropped');
    expect(reader.unsaid(text)).toBe('<voice>All green.</voice>');
    reader.accepted('All green.')('played');
    expect(reader.unsaid(text)).toBe('');
  });

  test('what became of a line of an earlier turn is not taken for this turn’s', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const settle = reader.accepted('All green.');
    reader.observe([person('u0'), person('u1')], LIVE);
    settle('played');
    expect(reader.unsaid('<voice>All green.</voice>')).toBe('<voice>All green.</voice>');
  });

  test('reset forgets everything: the next look is a first look', () => {
    const reader = createLiveReader();
    const rows = [person(), ferret('<voice>Hello.</voice>')];
    reader.observe([person()], LIVE);
    expect(reader.observe(rows, LIVE).lines).toHaveLength(1);
    reader.accepted('Hello.');
    reader.reset();
    expect(reader.unsaid('<voice>Hello.</voice>')).toBe('<voice>Hello.</voice>');
    expect(reader.observe(rows, LIVE).lines).toEqual([]);
  });
});
