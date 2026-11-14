import { describe, expect, test } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { type GrammarName, readVerb } from '../../../cli/lib/verb-flags.ts';

/** What the shell hands a verb: its fixed-rule reading (a switch swallows the word after it) and the words as typed. */
const typed = (...raw: string[]): VerbInvocation => {
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let at = 0; at < raw.length; at += 1) {
    const token = raw[at] as string;
    if (!token.startsWith('-')) args.push(token);
    else {
      const next = raw[at + 1];
      const name = token.replace(/^-+/u, '');
      if (next !== undefined && !next.startsWith('-')) {
        options[name] = next;
        at += 1;
      } else options[name] = true;
    }
  }
  return { args, options, raw };
};

const read = (verb: GrammarName, ...raw: string[]) => readVerb(verb, typed(...raw));

describe('an item verb reads the words as they were typed', () => {
  test('a switch never takes the word after it: `answer A1 --json A2` answers A1 with "A2"', () => {
    const got = read('answer', 'A1', '--json', 'A2');
    expect(got).toMatchObject({ ok: true, args: ['A1', 'A2'], flags: { json: true } });
  });

  test('`step A4 --undo 1 --json` unticks step 1 of A4', () => {
    expect(read('step', 'A4', '--undo', '1', '--json')).toMatchObject({
      ok: true,
      args: ['A4', '1'],
      flags: { undo: true, json: true },
    });
  });

  test('keeps the order of the words around several switches', () => {
    expect(read('add', '--todo', 'First', '--json', 'Second')).toMatchObject({
      ok: true,
      args: ['First', 'Second'],
      flags: { todo: true, json: true },
    });
  });

  test('a value flag takes the next word whatever it looks like, and `=` and the short spelling work', () => {
    expect(read('edit', 'A1', '--title', '-dash-start')).toMatchObject({ ok: true, flags: { title: '-dash-start' } });
    expect(read('edit', 'A1', '--title=Equals')).toMatchObject({ ok: true, flags: { title: 'Equals' } });
    expect(read('edit', 'A1', '-t', 'Short')).toMatchObject({ ok: true, flags: { title: 'Short' } });
  });

  test('repeats of a list flag keep every value in order', () => {
    expect(read('add', 'Ask', '--premise', 'one', '--premise', 'two')).toMatchObject({
      ok: true,
      flags: { premise: ['one', 'two'] },
    });
  });

  test('everything after -- is a word, even one that looks like a flag', () => {
    expect(read('answer', 'A1', '--', '--json', 'is', 'text')).toMatchObject({
      ok: true,
      args: ['A1', '--json', 'is', 'text'],
    });
  });
});

describe('nothing a verb was given is ignored', () => {
  test('an unknown flag is refused by name, with what the verb does take', () => {
    const got = read('ls', '--jsno');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain('unknown option --jsno');
  });

  test('a flag that belongs to another verb is unknown here', () => {
    expect(read('dismiss', 'A1', '--yes')).toMatchObject({ ok: false });
    expect(read('done', 'A1', '--yes')).toMatchObject({ ok: true, flags: { yes: true } });
  });

  test('excess words are refused with how many the verb takes', () => {
    const got = read('dismiss', 'A1', 'A2');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain('takes one word, not 2 (A1 A2)');
  });

  test('missing words are refused with the usage line', () => {
    const got = read('done');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain('usage: fy agenda done <id>');
    expect(read('answer', 'A1')).toMatchObject({ ok: false });
  });

  test('a value flag with no value, and a switch given one, are refused', () => {
    expect(read('edit', 'A1', '--title')).toMatchObject({ ok: false });
    expect(read('ls', '--json=maybe')).toMatchObject({ ok: false });
  });

  test('--session, -s and --ferret name the board, except on `mode`, where --ferret is the ferret to switch', () => {
    expect(read('show', 'A1', '-s', 'f2')).toMatchObject({ ok: true, flags: { session: 'f2' } });
    expect(read('show', 'A1', '--ferret', 'f3')).toMatchObject({ ok: true, flags: { session: 'f3' } });
    const mode = read('mode', 'on', '--ferret', 'f4');
    expect(mode).toMatchObject({ ok: true, args: ['on'], ferret: 'f4' });
    if (mode.ok) expect(mode.flags).not.toHaveProperty('session');
    expect(read('open', '--session', 'f2')).toMatchObject({ ok: false });
  });

  test('a caller that has only the shell’s reading gets the same grammar', () => {
    expect(readVerb('dismiss', { args: ['A1', 'A2'], options: { json: true } })).toMatchObject({ ok: false });
    expect(readVerb('rest', { args: ['A1'], options: { why: 'Reading the logs' } })).toMatchObject({
      ok: true,
      args: ['A1'],
      flags: { why: 'Reading the logs' },
    });
  });
});
