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
      { id: 'a1#0', text: 'On it.', kind: 'first' },
    ]);
    // The same text again says nothing more.
    expect(reader.observe([person('u0'), ask, ferret('<voice>On it.</voice>')], LIVE).lines).toEqual([]);
    const grown = ferret('<voice>On it.</voice>\n\nRan the tests.\n\n<voice>Tests are running.</voice>');
    expect(reader.observe([person('u0'), ask, grown], LIVE).lines).toEqual([
      { id: 'a1#1', text: 'Tests are running.', kind: 'line' },
    ]);
    const done = ferret('<voice>On it.</voice>\n\n<voice>Tests are running.</voice>\n\n<voice>All green.</voice>');
    expect(reader.observe([person('u0'), ask, done], LIVE).lines).toEqual([
      { id: 'a1#2', text: 'All green.', kind: 'line' },
    ]);
  });

  test('a line still being written (no closing tag) is not said until it closes', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sen')], LIVE).lines).toEqual([]);
    expect(reader.observe([person('u0'), ask, ferret('<voice>Half a sentence.</voice>')], LIVE).lines).toEqual([
      { id: 'a1#0', text: 'Half a sentence.', kind: 'first' },
    ]);
  });

  test('a new message from the person starts a new turn: its first line is first again', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const one = [person('u1'), ferret('<voice>One.</voice>', 'a1')];
    expect(reader.observe(one, LIVE).lines).toEqual([{ id: 'a1#0', text: 'One.', kind: 'first' }]);
    const two = [...one, person('u2'), ferret('<voice>Two.</voice>', 'a2')];
    expect(reader.observe(two, LIVE).lines).toEqual([{ id: 'a2#0', text: 'Two.', kind: 'first' }]);
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
    expect(reader.observe([person('u0'), ask, narration, tool()], LIVE).progress).toEqual(['a1#0']);
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
  /** The reply the reading picked: one row, `a1`, whose lines are `a1#0` and `a1#1`. */
  const pick = (markdown: string, id = 'a1') => ({ markdown, rows: [{ id, text: markdown }] });

  test('text nothing of which was said live is read as it stands', () => {
    const reader = createLiveReader();
    expect(reader.unsaid(pick(text))).toBe(text);
    expect(reader.unsaid(pick('No spoken lines here.'))).toBe('No spoken lines here.');
    expect(reader.unsaid(pick(''))).toBe('');
  });

  test('a line being said, or played, is not said again; when all of them were, nothing is', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const first = reader.accepted('a1#0');
    reader.accepted('a1#1');
    expect(reader.unsaid(pick(text))).toBe('');
    first('played');
    expect(reader.unsaid(pick(text))).toBe('');
  });

  test('a line that was not played (it failed, was talked over or the stream went) is read, and only that one', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    reader.accepted('a1#0')('played');
    reader.accepted('a1#1')('unplayed');
    expect(reader.unsaid(pick(text))).toBe('<voice>All green.</voice>');
  });

  test('a line dropped on purpose is never read again, a line never handed over is', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    reader.accepted('a1#0')('dropped');
    expect(reader.unsaid(pick(text))).toBe('<voice>All green.</voice>');
    reader.accepted('a1#1')('played');
    expect(reader.unsaid(pick(text))).toBe('');
  });

  test('what became of a line of an earlier turn is not taken for this turn’s', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const settle = reader.accepted('a1#1');
    reader.observe([person('u0'), person('u1')], LIVE);
    settle('played');
    expect(reader.unsaid(pick('<voice>All green.</voice>'))).toBe('<voice>All green.</voice>');
  });

  test('reset forgets everything: the next look is a first look', () => {
    const reader = createLiveReader();
    const rows = [person(), ferret('<voice>Hello.</voice>')];
    reader.observe([person()], LIVE);
    expect(reader.observe(rows, LIVE).lines).toHaveLength(1);
    reader.accepted('a1#0');
    reader.reset();
    expect(reader.unsaid(pick('<voice>Hello.</voice>'))).toBe('<voice>Hello.</voice>');
    expect(reader.observe(rows, LIVE).lines).toEqual([]);
  });
});

describe('a line is known by its id, not its words', () => {
  test('a result that opens with the very sentence a progress line said keeps its own line: only the progress line is progress', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const ask = person('u1');
    const progress = ferret('<voice>The build passed.</voice>', 'a1');
    reader.observe([person('u0'), ask, progress], LIVE);
    const result = ferret('<voice>The build passed.</voice>\n\n<voice>The release is ready.</voice>', 'a2');
    const looked = reader.observe([person('u0'), ask, progress, tool(), result], LIVE);
    expect(looked.lines.map(line => line.id)).toEqual(['a2#0', 'a2#1']);
    expect(looked.progress).toEqual(['a1#0']);
  });

  test('a repeated sentence in two rows is two lines: what became of one is not what became of the other', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    reader.accepted('a1#0')('played');
    const second = { markdown: '<voice>Same.</voice>', rows: [{ id: 'a2', text: '<voice>Same.</voice>' }] };
    expect(reader.unsaid(second)).toBe('<voice>Same.</voice>');
  });
});

describe('a reply that is still being said when the turn ends', () => {
  const reply = { markdown: '<voice>All green.</voice>', rows: [{ id: 'a1', text: '<voice>All green.</voice>' }] };

  test('a late failure of the only line hands the reading back, once, and it then says the line', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const settle = reader.accepted('a1#0');
    let again = 0;
    expect(reader.unsaid(reply, () => (again += 1))).toBe('');
    expect(again).toBe(0);
    settle('failed');
    expect(again).toBe(1);
    expect(reader.unsaid(reply)).toBe('<voice>All green.</voice>');
  });

  test('a line that plays, or is talked over, hands nothing back; what the reading took is not taken twice', () => {
    const reader = createLiveReader();
    reader.observe([person('u0')], LIVE);
    const settle = reader.accepted('a1#0');
    let again = 0;
    expect(reader.unsaid(reply, () => (again += 1))).toBe('');
    settle('played');
    expect(again).toBe(0);
    const other = createLiveReader();
    other.observe([person('u0')], LIVE);
    const failing = other.accepted('a1#0');
    other.accepted('a1#1');
    const two = {
      markdown: '<voice>On it.</voice>\n\n<voice>All green.</voice>',
      rows: [{ id: 'a1', text: '<voice>On it.</voice>\n\n<voice>All green.</voice>' }],
    };
    let retried = 0;
    expect(other.unsaid(two, () => (retried += 1))).toBe('');
    failing('failed');
    expect(retried).toBe(1);
    // The failed line is read now; the other is still being said, and a failure of it is handed back as well.
    expect(other.unsaid(two, () => (retried += 1))).toBe('<voice>On it.</voice>');
    expect(other.unsaid(two)).toBe('');
  });
});
