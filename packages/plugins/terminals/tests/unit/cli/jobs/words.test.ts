import { describe, it } from 'bun:test';
import should from 'should';
import { commandFromWords, parseDuration, shellQuote } from '../../../../cli/lib/jobs/words.ts';

describe('the words after fy job run --', () => {
  it('should take ONE word as a shell command line, exactly as written', () => {
    should(commandFromWords(['sleep 1 && echo "$HOME" | tr a b'])).equal('sleep 1 && echo "$HOME" | tr a b');
  });

  it('should take several words as an argv, each quoted to arrive as typed', () => {
    should(commandFromWords(['bash', '-c', 'echo hi; ls'])).equal("bash -c 'echo hi; ls'");
    should(commandFromWords(['echo', "it's"])).equal(`echo 'it'"'"'s'`);
  });

  it('should leave plain words bare and quote the empty word', () => {
    should(shellQuote('bun')).equal('bun');
    should(shellQuote('./a-b_c.sh')).equal('./a-b_c.sh');
    should(shellQuote('')).equal("''");
  });
});

describe('durations', () => {
  it('should read seconds by default and the s m h d ms units', () => {
    should(parseDuration('30')).equal(30_000);
    should(parseDuration('30s')).equal(30_000);
    should(parseDuration('5m')).equal(300_000);
    should(parseDuration('2h')).equal(7_200_000);
    should(parseDuration('1d')).equal(86_400_000);
    should(parseDuration('250ms')).equal(250);
    should(parseDuration('1.5m')).equal(90_000);
  });

  it('should refuse anything else', () => {
    should(parseDuration('soon')).be.undefined();
    should(parseDuration('-5')).be.undefined();
    should(parseDuration('')).be.undefined();
  });
});
