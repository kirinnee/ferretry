/**
 * A switch a verb DECLARES never takes the next word (`fy new --allow-scratch "<prompt>"`): the shell reads the verb's own
 * manifest options, through the REAL verb table and the REAL Ferrets half, over a fake daemon. Before, the prompt was read
 * as the switch's value (`allow-scratch: "say hello"`), the switch was off, the folder was refused and the prompt was lost.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { declaredSwitches, parseArgs } from '../../src/lib/argv.ts';
import { registry } from '../../src/generated/commands.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';

const entryOf = (words: readonly string[]) => {
  const resolved = resolveVerb(buildVerbTable(registry), words);
  if (resolved.kind !== 'verb') throw new Error(`${words.join(' ')} must resolve to a verb`);
  return resolved;
};

/** What the shell reads for the words typed after the verb, with that verb's own declared switches. */
const read = (words: readonly string[]) => {
  const { entry, rest } = entryOf(words);
  return parseArgs(rest, declaredSwitches(entry.options));
};

describe('a declared boolean switch never takes a value', () => {
  it('fy new --allow-scratch "<prompt>": the switch is on and the prompt is the word', () => {
    const parsed = read(['new', '--allow-scratch', 'say hello', '--runtime', 'rt']);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options['allow-scratch']).equal(true);
    should(parsed.options.runtime).equal('rt');
  });

  it('fy new "<prompt>" --allow-scratch: the same reading with the switch last', () => {
    const parsed = read(['new', '--runtime', 'rt', 'say hello', '--allow-scratch']);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options['allow-scratch']).equal(true);
  });

  it('fy new --allow-scratch=false "<prompt>": an attached value is the only way to give a switch one', () => {
    const parsed = read(['new', '--allow-scratch=false', 'say hello', '--auto']);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options['allow-scratch']).equal('false');
    should(parsed.options.auto).equal(true);
  });

  it("fy daemon restart --when-idle <word>: another verb's declared switch reads the same way", () => {
    const parsed = read(['daemon', 'restart', '--when-idle', 'now']);
    should(parsed.args).deepEqual(['now']);
    should(parsed.options['when-idle']).equal(true);
  });

  it('a value option the verb declares still takes its word (fy new --runtime rt)', () => {
    const parsed = read(['new', '--runtime', 'rt', 'brief']);
    should(parsed.options.runtime).equal('rt');
    should(parsed.args).deepEqual(['brief']);
  });
});
