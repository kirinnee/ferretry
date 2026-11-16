import { describe, it } from 'bun:test';
import should from 'should';
import { declaredSwitches, optionOn, optionText, parseArgs } from '../../src/lib/argv.ts';

describe('parseArgs', () => {
  it('should split positionals from options', () => {
    const parsed = parseArgs(['c1', '--to', 'done', '--force']);
    should(parsed.args).deepEqual(['c1']);
    should(parsed.options).deepEqual({ to: 'done', force: true });
  });

  it('should read a trailing option with no value as a switch (the verb that needs a value says so)', () => {
    should(parseArgs(['fixture prompt', '--compact-at']).options).deepEqual({ 'compact-at': true });
  });

  it('should read --name=value, --no-name and repeats', () => {
    const parsed = parseArgs(['--label=a', '--label', 'b', '--no-color']);
    should(parsed.options).deepEqual({ label: ['a', 'b'], color: false });
  });

  it('should treat everything after -- as positional', () => {
    const parsed = parseArgs(['--json', '--', '--not-an-option', 'x']);
    should(parsed.args).deepEqual(['--not-an-option', 'x']);
    should(parsed.options).deepEqual({ json: true });
  });

  it('should keep a lone dash as a value (stdin)', () => {
    should(parseArgs(['--file', '-']).options).deepEqual({ file: '-' });
  });

  it('should answer option helpers', () => {
    const parsed = parseArgs(['--text', 'hi', '--yes']);
    should(optionText(parsed, 'text')).equal('hi');
    should(optionText(parsed, 'yes')).be.undefined();
    should(optionOn(parsed, 'yes')).be.true();
    should(optionOn(parsed, 'nope')).be.false();
  });
});

describe('parseArgs negative numbers', () => {
  it('should read a negative number after an option as its value, not as an option', () => {
    should(parseArgs(['dev', '--pages', '-1', '--by', '-300,0']).options).deepEqual({ pages: '-1', by: '-300,0' });
  });

  it('should keep a negative number as a positional word', () => {
    const parsed = parseArgs(['-1', '--json']);
    should(parsed.args).deepEqual(['-1']);
    should(parsed.options).deepEqual({ json: true });
  });
});

describe('parseArgs swallowed words', () => {
  it('should record each word an option took, with the positional words that came before it', () => {
    // Arrange / Act
    const parsed = parseArgs(['app', '--double', '#go', 'more', '--level', 'error']);

    // Assert
    should(parsed.args).deepEqual(['app', 'more']);
    should(parsed.swallowed).deepEqual([
      { option: 'double', word: '#go', at: 1 },
      { option: 'level', word: 'error', at: 2 },
    ]);
  });

  it('should leave the field out when no option took a word, so the result is what it always was', () => {
    should(parseArgs(['c1', '--force', '--to=done'])).deepEqual({
      args: ['c1'],
      options: { force: true, to: 'done' },
      raw: ['c1', '--force', '--to=done'],
    });
  });
});

describe('parseArgs: the order every option was written in', () => {
  it('should record each written occurrence, whatever its spelling, in order', () => {
    const parsed = parseArgs(['--session', 'outer', 'x', '-s', 'middle', '--session=inner', '--no-color', '--force']);
    should(parsed.written).deepEqual(['session', 's', 'session', 'color', 'force']);
  });

  it('should say nothing when no option name was repeated (the order is then the order of the options)', () => {
    should(parseArgs(['a', '--', '--b']).written).be.undefined();
    should(parseArgs(['-s', 'a', '--session', 'b']).written).be.undefined();
  });
});

describe('parseArgs: a declared switch never takes a value', () => {
  const NEW = declaredSwitches([
    { flag: '--runtime <name>' },
    { flag: '--auto' },
    { flag: '--allow-scratch' },
    { flag: '-f, --force' },
    { flag: '--since [dur]' },
  ]);

  it('should read the declared switches from the flags that name no value', () => {
    should([...NEW].sort()).deepEqual(['allow-scratch', 'auto', 'f', 'force']);
    should([...declaredSwitches(undefined)]).deepEqual([]);
  });

  it('should keep the prompt as a word when the switch is written BEFORE it', () => {
    const parsed = parseArgs(['--allow-scratch', 'say hello', '--runtime', 'rt'], NEW);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options).deepEqual({ 'allow-scratch': true, runtime: 'rt' });
    should(parsed.swallowed).be.undefined();
  });

  it('should keep the prompt as a word when the switch is written AFTER it', () => {
    const parsed = parseArgs(['say hello', '--allow-scratch', '--runtime', 'rt'], NEW);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options).deepEqual({ 'allow-scratch': true, runtime: 'rt' });
  });

  it('should give a switch a value only when it is attached: --allow-scratch=false', () => {
    const parsed = parseArgs(['--allow-scratch=false', 'say hello'], NEW);
    should(parsed.args).deepEqual(['say hello']);
    should(parsed.options).deepEqual({ 'allow-scratch': 'false' });
    should(optionOn(parsed, 'allow-scratch')).be.false();
    should(optionOn(parseArgs(['--allow-scratch=true'], NEW), 'allow-scratch')).be.true();
  });

  it('should still let a declared VALUE option take its word, and a short switch stand alone', () => {
    const parsed = parseArgs(['-f', 'brief', '--runtime', 'rt', '--since', '7d'], NEW);
    should(parsed.args).deepEqual(['brief']);
    should(parsed.options).deepEqual({ f: true, runtime: 'rt', since: '7d' });
  });

  it('should read an undeclared option the old way (a verb that declares nothing keeps the fixed rule)', () => {
    should(parseArgs(['--allow-scratch', 'say hello']).options).deepEqual({ 'allow-scratch': 'say hello' });
  });
});
