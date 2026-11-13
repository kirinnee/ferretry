import { describe, it } from 'bun:test';
import should from 'should';
import { parseArgs } from '../../support/shell-argv.ts';
import { flag, parseVerb, UsageError, type VerbShape } from '../../../cli/lib/args.ts';

const SHAPE: VerbShape = {
  args: [{ name: 'page name' }, { name: 'target' }, { name: 'text', optional: true, rest: true }],
  flags: {
    double: flag.on('double'),
    timeout: flag.whole('timeout', 't'),
    pages: flag.number('pages'),
    type: flag.list('type'),
    level: flag.text('level'),
    ask: flag.either('ask'),
  },
};
const read = (...tokens: string[]) => parseVerb('browser page click', SHAPE, parseArgs(tokens));

describe('reading a verb’s words', () => {
  it('should read each option as the kind it was declared, under every one of its names', () => {
    // Arrange / Act
    const words = read('dev', '#go', '-t', '5000', '--pages', '-1', '--type', 'xhr,fetch', '--type', 'script');

    // Assert
    should(words.num('timeout')).equal(5000);
    should(words.num('pages')).equal(-1);
    should(words.list('type')).deepEqual(['xhr', 'fetch', 'script']);
  });

  it('should refuse an option the verb does not declare, naming it and what the verb takes', () => {
    should(() => read('dev', '#go', '--bogus')).throw(UsageError);
    should(() => read('dev', '#go', '--bogus')).throw(/no option --bogus; it takes --double, --timeout/u);
  });

  it('should refuse a missing and a surplus argument in words', () => {
    should(() => read('dev')).throw(/needs the target/u);
    should(() =>
      parseVerb('browser page close', { args: [{ name: 'page name' }], flags: {} }, parseArgs(['a', 'b'])),
    ).throw(/takes at most 1 \(page name\), not "b"/u);
  });

  it('should hand a word a switch swallowed back as an argument', () => {
    // `--double dev '#go'`: the shell reads `dev` as the value of `--double`.
    const words = read('--double', 'dev', '#go');
    should(words.on('double')).be.true();
    should(words.args).deepEqual(['dev', '#go']);
  });

  it('should refuse a value that is not the number it must be, without echoing more than the word', () => {
    should(() => read('dev', '#go', '--timeout', 'soon')).throw('--timeout must be a whole number, not "soon"');
    should(() => read('dev', '#go', '--pages', 'lots')).throw('--pages must be a number, not "lots"');
  });

  it('should refuse an option that needs a value and got none', () => {
    should(() => read('dev', '#go', '--level')).throw('--level needs a value');
  });

  it('should read an option that is a switch or carries a word', () => {
    should(read('dev', '#go', '--ask').either('ask')).equal(true);
    should(read('dev', '#go', '--ask', 'type the code').either('ask')).equal('type the code');
    should(read('dev', '#go').either('ask')).be.undefined();
  });
});
