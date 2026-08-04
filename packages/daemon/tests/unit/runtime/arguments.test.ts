import { describe, it } from 'bun:test';
import should from 'should';
import { answerArguments, daemonUsageText, EXIT_USAGE } from '../../../src/lib/runtime/arguments.ts';

const USAGE = { daemonName: 'fyd', clientName: 'fy', version: '1.2.3' };

/** The refusal text, or a failure that says what was answered instead. */
function refusalText(argv: readonly string[]): string {
  const answer = answerArguments(argv, USAGE);
  if (answer.kind !== 'refuse') throw new Error(`expected a refusal for ${argv.join(' ')}, got ${answer.kind}`);
  should(answer.exitCode).equal(EXIT_USAGE);
  return answer.text;
}

describe('daemon command line', () => {
  it('should boot only when it was given no arguments at all', () => {
    // Act + Assert — the only invocation a service manager ever makes.
    should(answerArguments([], USAGE)).deepEqual({ kind: 'boot', overrides: {} });
  });

  it('should print the version without asking for anything else', () => {
    // Act
    const long = answerArguments(['--version'], USAGE);
    const short = answerArguments(['-v'], USAGE);

    // Assert — this used to provision a state home and attempt to serve. A query stays a query.
    should(long).deepEqual({ kind: 'print', text: '1.2.3', exitCode: 0 });
    should(short).deepEqual(long);
  });

  it('should explain what it is, who starts it, and what its exit codes mean', () => {
    // Act
    const answer = answerArguments(['--help'], USAGE);
    const text = daemonUsageText(USAGE);

    // Assert
    should(answer).deepEqual({ kind: 'print', text, exitCode: 0 });
    should(answerArguments(['-h'], USAGE)).deepEqual(answer);
    should(text).match(/fy daemon start/u);
    should(text).match(/FY_HOME/u);
    should(text).match(/--print-config/u);
    should(text).match(/--check/u);
    // The exit codes are the daemon's contract with whatever supervises it, and there was previously
    // nowhere at all to read them.
    should(text).match(/^ {2}69 {2,}/mu);
    should(text).match(/^ {2}78 {2,}/mu);
    should(text).match(/^ {2}64 {2,}/mu);
  });

  it('should read the overrides one run may state', () => {
    // Act
    const answer = answerArguments(
      ['--config', '/etc/fyd.json', '--host', '0.0.0.0', '--port', '9100', '--log-level', 'warn'],
      USAGE,
    );

    // Assert
    should(answer).deepEqual({
      kind: 'boot',
      overrides: { configFile: '/etc/fyd.json', host: '0.0.0.0', port: 9_100, logLevel: 'warn' },
    });
  });

  it('should carry the overrides into the queries that only read', () => {
    // Act + Assert — both answer from the same configuration a boot would have used, or they would
    // be reporting on something other than what would happen.
    should(answerArguments(['--print-config', '--port', '9100'], USAGE)).deepEqual({
      kind: 'print-config',
      overrides: { port: 9_100 },
    });
    should(answerArguments(['--check'], USAGE)).deepEqual({ kind: 'check', overrides: {} });
  });

  it('should refuse anything it does not understand rather than booting anyway', () => {
    // Act + Assert — an ignored flag is how somebody ends up believing they configured something.
    should(refusalText(['--serve'])).match(/--serve/u);
    // The usage comes WITH the refusal: whoever just got an option wrong needs to see the options.
    should(refusalText(['--serve'])).match(/--print-config/u);
    should(refusalText(['-x'])).match(/-x/u);
  });

  it('should refuse a value flag with nothing to read, and a value it cannot use', () => {
    // Act + Assert
    should(refusalText(['--port'])).match(/needs a value/u);
    // The next argument being another flag is not a value: `--port --host x` would otherwise take
    // "--host" as the port and refuse it for the wrong reason.
    should(refusalText(['--port', '--host'])).match(/needs a value/u);
    should(refusalText(['--port', 'seventy'])).match(/not a port number/u);
    should(refusalText(['--port', '0'])).match(/not a port number/u);
    should(refusalText(['--port', '70000'])).match(/not a port number/u);
    should(refusalText(['--log-level', 'chatty'])).match(/not a log level/u);
    should(refusalText(['--host', ' '])).match(/must not be empty/u);
  });

  it('should refuse a query combined with anything that is not a question', () => {
    // Act + Assert — guessing which half of `--version --port 80` to honour is the ignoring defect
    // again, and the two queries ask different questions of the same world.
    should(refusalText(['--version', '--port', '80'])).match(/on its own/u);
    should(refusalText(['--help', '--check'])).match(/on its own/u);
    should(refusalText(['--print-config', '--check'])).match(/different questions/u);
  });
});
