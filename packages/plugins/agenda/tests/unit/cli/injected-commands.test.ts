import { describe, expect, it } from 'bun:test';
import { agendaBriefRequiredProblems } from '@ferretry/core-asks/contract';
import { TRACK_ASK_COMMAND } from '@ferretry/plugin-board/contract';
import { readVerb } from '../../../cli/lib/verb-flags.ts';

/** The words of a command line as a shell reads them: bare words, or "double quoted" ones. */
const wordsOf = (line: string): string[] => [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map(w => w[1] ?? w[2] ?? '');

describe('a command another plugin tells a ferret to run through fy agenda', () => {
  it('should be read by the real agenda add parser and carry the brief it requires (the board off-board hint)', () => {
    const [fy, agenda, verb, ...raw] = wordsOf(TRACK_ASK_COMMAND);
    expect([fy, agenda, verb]).toEqual(['fy', 'agenda', 'add']);
    const read = readVerb('add', { args: [], options: {}, raw });
    if (!read.ok) throw new Error(read.message);
    const flags = read.flags as unknown as { premise?: readonly string[]; context?: readonly string[] };
    expect(read.args).toEqual(['Track this on the board?']);
    expect(
      agendaBriefRequiredProblems({ premise: flags.premise?.join(' '), context: flags.context?.join(' ') }),
    ).toEqual([]);
  });
});
