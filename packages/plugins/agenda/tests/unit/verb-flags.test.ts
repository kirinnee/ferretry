import { describe, expect, test } from 'bun:test';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { type GrammarName, readVerb } from '../../cli/lib/verb-flags.ts';

/** What the shell hands a verb: the words as typed (`raw`), which is what the reader trusts. */
const typed = (...raw: string[]): VerbInvocation => ({ args: [], options: {}, raw });
const read = (verb: GrammarName, ...raw: string[]) => readVerb(verb, typed(...raw));
const refusal = (verb: GrammarName, ...raw: string[]): string => {
  const got = read(verb, ...raw);
  if (got.ok) throw new Error('expected a refusal');
  return got.message;
};

describe("Agenda's own verbs read the words as typed", () => {
  test('a value flag takes the next word or its `=` value; a switch never takes the word after it', () => {
    expect(read('open', '--limit', '5', '--after=c1')).toMatchObject({ ok: true, flags: { limit: '5', after: 'c1' } });
    expect(read('clear', '--agents', '--dry-run')).toMatchObject({ ok: true, flags: { agents: true, dryRun: true } });
    expect(read('mode', 'off', '--ferret', 'f1')).toMatchObject({ ok: true, args: ['off'], ferret: 'f1' });
  });

  test('`--no-<switch>` and `--<switch>=false` turn a switch off, and `--` ends the flags', () => {
    expect(read('clear', '--agents', '--no-agents')).toMatchObject({ ok: true, flags: {} });
    expect(read('clear', '--yes=false')).toMatchObject({ ok: true, flags: {} });
    expect(read('mode', '--', '--odd')).toMatchObject({ ok: true, args: ['--odd'] });
    expect(read('mode', '-')).toMatchObject({ ok: true, args: ['-'] });
  });

  test('a flag it does not know, or a `--no-` of a value flag, is refused with the usage', () => {
    expect(refusal('open', '--nope')).toBe(
      'fy agenda open: unknown option --nope; it takes --json, --limit, --after\nusage: fy agenda open [--limit <n>] [--after <cursor>]',
    );
    expect(refusal('open', '--no-limit')).toContain('unknown option --no-limit');
    expect(refusal('open', '--agents')).toContain('unknown option --agents');
    expect(refusal('roll' as GrammarName, '-x')).toContain('fy agenda: unknown option -x');
  });

  test('a switch given a value, a value flag with none, and a wrong number of words are each refused', () => {
    expect(refusal('clear', '--yes=maybe')).toContain('--yes is a switch and takes no value, not "maybe"');
    expect(refusal('open', '--limit')).toContain('--limit <value> needs a value');
    expect(refusal('mode', 'on', 'off')).toContain('it takes one word, not 2 (on off)');
    expect(refusal('clear', 'a', 'b', 'c')).toContain('it takes 0 words, not 3 (a b c)');
  });

  test('a caller with no raw words has them rebuilt from its reading of the options', () => {
    expect(readVerb('mode', { args: ['on'], options: { json: true, yes: false, ferret: 'f1' } })).toMatchObject({
      ok: true,
      args: ['on'],
      ferret: 'f1',
      flags: { json: true, ferret: 'f1' },
    });
    expect(readVerb('open', { args: [], options: { limit: ['3'] } })).toMatchObject({
      ok: true,
      flags: { limit: '3' },
    });
    expect(readVerb('clear', { args: [], options: { y: true } })).toMatchObject({ ok: false });
  });
});
