import { describe, expect, it, test } from 'bun:test';
import { definePlugin, verb } from '@ferretry/kernel/manifest';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { argsOf, renderGroupHelp, renderRootHelp, renderVerbHelp, verbsUnder, wrap } from '../../src/lib/help.ts';
import { runFy } from '../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../src/lib/verbs.ts';
import { boardEntry, fakeWorld, registryOf, skeletonEntry } from './fakes.ts';

const plugin = definePlugin({
  id: 'toy',
  title: 'Toy',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  actions: {
    cli: [
      verb('toy open', {
        summary: 'open a named toy, optionally running a command in it',
        args: [
          { name: 'name', help: 'its name' },
          { name: 'command', help: 'a command to run in it', optional: true, variadic: true },
        ],
        options: [{ flag: '-s, --session <id>', help: 'act on this session yourself' }],
      }),
      verb('toy list', { summary: 'list the toys', args: [] }),
      verb('an-extremely-long-verb-name-that-would-glue-its-description <id>', {
        summary: 'a sentence that must not be glued to the verb',
        args: [{ name: 'id', help: 'the id' }],
      }),
    ],
  },
});
const toyTable = () => buildVerbTable(registryOf(skeletonEntry(plugin)));
const entryOf = (words: readonly string[]) => {
  const resolved = resolveVerb(toyTable(), words);
  if (resolved.kind !== 'verb') throw new Error('no such verb');
  return resolved.entry;
};

describe('help renderer', () => {
  it('should lay a verb out as usage, summary, Arguments and Options with the argument placeholders', () => {
    const table = toyTable();
    const text = renderVerbHelp('fy', entryOf(['toy', 'open']), table);
    should(text).containEql('Usage: fy toy open <name> [command...] [options]');
    should(text).containEql('open a named toy, optionally running a command in it');
    should(text).containEql('Arguments:\n  name     its name\n  command  a command to run in it');
    should(text).containEql(
      'Options:\n  -s, --session <id>  act on this session yourself\n  -h, --help          show this help',
    );
  });

  it('should list no Arguments section for a verb that takes none', () => {
    const text = renderVerbHelp('fy', entryOf(['toy', 'list']), toyTable());
    should(text).not.containEql('Arguments:');
    should(text).containEql('Usage: fy toy list [options]');
  });

  it('should derive arguments from the verb line when none are declared', () => {
    const args = argsOf({ line: 'stop cascade <session> [more...]' });
    should(args.map(arg => [arg.name, arg.optional === true, arg.variadic === true])).deepEqual([
      ['session', false, false],
      ['more', true, true],
    ]);
  });

  it('should list the verbs under a group, with their arguments, and name no verb outside it', () => {
    const table = toyTable();
    should(verbsUnder(table, ['toy']).map(entry => entry.line)).deepEqual(['toy open', 'toy list']);
    const text = renderGroupHelp('fy', ['toy'], table);
    should(text).containEql('Usage: fy toy <verb> [arguments] [options]');
    should(text).containEql('open <name> [command...]');
    should(text).containEql('list ');
    should(text).not.containEql('an-extremely');
  });

  it('should keep a long verb name apart from its description and align the rest', () => {
    const text = renderRootHelp('fy', toyTable(), { toy: 'Toy' });
    const lines = text.split('\n');
    const longIndex = lines.findIndex(
      line => line.trim() === 'an-extremely-long-verb-name-that-would-glue-its-description',
    );
    should(longIndex).be.above(0);
    // The description of a verb too wide for the column starts on the next line, never glued on.
    should(lines[longIndex + 1]?.trim()).startWith('a sentence that must not be glued');
    const open = lines.find(line => line.trim().startsWith('toy open')) as string;
    const list = lines.find(line => line.trim().startsWith('toy list')) as string;
    should(open.indexOf('open a named')).equal(list.indexOf('list the toys'));
  });

  it('should wrap a sentence at the given width and keep a long word whole', () => {
    should(wrap('one two three four', 9)).deepEqual(['one two', 'three', 'four']);
    should(wrap('supercalifragilistic is long', 5)).deepEqual(['supercalifragilistic', 'is', 'long']);
  });

  it('should keep every root help line within 80 columns for the compiled registry', () => {
    const text = renderRootHelp('fy', buildVerbTable(registry), {});
    // A single unbreakable word (a file path) may run past the column; a sentence never does.
    const wide = text.split('\n').filter(line => line.length > 80 && line.trim().includes(' '));
    should(wide).deepEqual([]);
  });
});

/**
 * Every verb the compiled `fy` registers states its arguments and options. A verb that takes nothing says so with an
 * empty `args`; a new verb that says nothing fails here, so help cannot quietly regress to one line.
 */
describe('every registered verb documents its arguments and options', () => {
  const table = buildVerbTable(registry);
  test('the table is not empty', () => expect(table.entries.length).toBeGreaterThan(300));

  test('each verb declares args or options', () => {
    const silent = table.entries.filter(entry => entry.args === undefined && (entry.options ?? []).length === 0);
    expect(silent.map(entry => entry.line)).toEqual([]);
  });

  test('every argument and option has a sentence', () => {
    const blank: string[] = [];
    for (const entry of table.entries) {
      for (const arg of argsOf(entry)) if (arg.help.trim() === '') blank.push(`${entry.line}: <${arg.name}>`);
      for (const option of entry.options ?? [])
        if (option.help.trim() === '') blank.push(`${entry.line}: ${option.flag}`);
    }
    expect(blank).toEqual([]);
  });

  test('every placeholder in a verb line has a declared argument of that name', () => {
    const missing: string[] = [];
    for (const entry of table.entries) {
      const declared = new Set((entry.args ?? []).map(arg => arg.name));
      for (const word of entry.line.split(/\s+/u)) {
        const match = /^[<[]([A-Za-z][\w-]*)/u.exec(word);
        if (match !== null && !declared.has(match[1] as string)) missing.push(`${entry.line}: ${word}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every verb renders a help with Usage and Options', () => {
    for (const entry of table.entries) {
      const text = renderVerbHelp('fy', entry, table);
      expect(text.startsWith(`Usage: fy ${entry.words.join(' ')}`)).toBe(true);
      expect(text).toContain('Options:');
    }
  });
});

describe('help through the router', () => {
  const run = async (argv: readonly string[]) => {
    const { world, io, connects } = fakeWorld({ registry: registryOf(skeletonEntry(plugin), boardEntry()) });
    const code = await runFy(argv, world);
    return { code, out: io.stdout(), err: io.stderr(), connects };
  };

  it('should print a group’s verbs for `<group> --help` and for -h, and exit 0 without connecting', async () => {
    for (const argv of [
      ['toy', '--help'],
      ['toy', '-h'],
    ]) {
      const result = await run(argv);
      should(result.code).equal(0);
      should(result.out).containEql('Usage: fy toy <verb>');
      should(result.out).containEql('open <name> [command...]');
      should(result.connects).deepEqual([]);
    }
  });

  it('should print a verb’s help for `help <verb ...>`', async () => {
    const result = await run(['help', 'toy', 'open']);
    should(result.code).equal(0);
    should(result.out).containEql('Usage: fy toy open <name> [command...] [options]');
    should(result.out).containEql('Arguments:');
  });

  it('should print a group’s help for `help <group>` and the root list for a bare `help`', async () => {
    should((await run(['help', 'toy'])).out).containEql('Usage: fy toy <verb>');
    const bare = await run(['help']);
    should(bare.code).equal(0);
    should(bare.out).containEql('Usage: fy <verb>');
  });

  it('should refuse `help <unknown>` as an unknown verb with exit 2', async () => {
    const result = await run(['help', 'nonsense']);
    should(result.code).equal(2);
    should(result.err).containEql('unknown verb "nonsense"');
  });

  it('should still refuse an unknown word with --help that names no group', async () => {
    const result = await run(['nonsense', '--help']);
    should(result.code).equal(2);
    should(result.err).containEql('unknown verb "nonsense"');
  });

  it('should print a verb’s own help for `<verb> --help`', async () => {
    const result = await run(['toy', 'open', '--help']);
    should(result.code).equal(0);
    should(result.out).containEql('Usage: fy toy open <name> [command...] [options]');
  });
});
