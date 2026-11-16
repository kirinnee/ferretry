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

  it('should keep every word where it was written when a switch sits between the arguments', () => {
    // Arrange / Act: the shell reads `#go` as the value of `--double`; its place among the words is recorded.
    const middle = read('app', '--double', '#go');
    const first = read('--double', 'app', '#go');
    const last = read('app', '#go', '--double');
    const two = read('app', '--double', '#go', '--double', 'more');

    // Assert
    should(middle.args).deepEqual(['app', '#go']);
    should(first.args).deepEqual(['app', '#go']);
    should(last.args).deepEqual(['app', '#go']);
    should(two.args).deepEqual(['app', '#go', 'more']);
    should(middle.on('double')).be.true();
  });

  it('should keep the words of two different switches in the order they were written', () => {
    // Arrange
    const shape: VerbShape = {
      args: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      flags: { one: flag.on('one'), two: flag.on('two') },
    };

    // Act
    const words = parseVerb('v', shape, parseArgs(['a', '--two', 'b', '--one', 'c', 'd']));

    // Assert
    should(words.args).deepEqual(['a', 'b', 'c', 'd']);
  });

  it('should not move the value of an option that takes one', () => {
    should(read('app', '--timeout', '500', '#go').args).deepEqual(['app', '#go']);
    should(read('app', '--timeout', '500', '#go').num('timeout')).equal(500);
  });

  it('should refuse a value given to a switch with an equals sign, naming the switch', () => {
    should(() => read('app', '#go', '--double=yes')).throw('--double is a switch and takes no value');
  });
});

describe('a targeting flag written under several names: the one nearest the end wins', () => {
  const FERRET: VerbShape = { args: [], flags: { ferret: flag.text('ferret', 'session', 's') } };
  const chosen = (...tokens: string[]): string | undefined =>
    parseVerb('browser status', FERRET, parseArgs(tokens)).text('ferret');

  it('should pick the last one written when a long name is repeated after a short one', () => {
    should(chosen('--session', 'outer', '-s', 'middle', '--session', 'inner')).equal('inner');
  });

  it('should pick the last one written whichever names it uses', () => {
    should(chosen('-s', 'a', '--session', 'b')).equal('b');
    should(chosen('--session', 'a', '-s', 'b')).equal('b');
    should(chosen('--ferret', 'a', '-s', 'b', '--ferret', 'c')).equal('c');
    should(chosen('-s', 'only')).equal('only');
  });

  it('should honour the equals spelling in the same order', () => {
    should(chosen('--session=a', '-s', 'b', '--session=c')).equal('c');
    should(chosen('--session', 'a', '--ferret=b', '-s', 'c')).equal('c');
    should(chosen('-s', 'a', '--ferret=b')).equal('b');
  });
});
