import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import chalk from 'chalk';
import type inquirer from 'inquirer';
import type { Ora } from 'ora';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';
import { InquirerPrompt } from '../../src/adapters/terminal/prompt';
import { OraSpinner } from '../../src/adapters/terminal/spinner';

describe('terminal and system adapters', () => {
  const level = chalk.level;

  afterEach(() => {
    mock.restore();
    chalk.level = level;
    process.exitCode = 0;
  });

  it('should route presentation output and exit state through ConsoleIo', () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const subject = new ConsoleIo();

    subject.success('saved');
    subject.warn('careful');
    subject.error('failed');
    subject.diagnostic('{"phase":"preflight"}');
    subject.setExitCode(7);

    expect(log).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1]?.[0]).toBe('{"phase":"preflight"}');
    expect(process.exitCode).toBe(7);
    expect(typeof subject.interactive()).toBe('boolean');
  });

  it('should put a report on stdout exactly as it was rendered', () => {
    // `success` paints its whole message green, which is right for "that worked" and wrong for a
    // report whose colour means something PER LINE: a green wrap over a status listing gave a
    // rejected row and a healthy one the same paint, so colour carried nothing and every row had
    // to be read to be triaged. The renderer has to be the last thing that paints.
    chalk.level = 1;
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    new ConsoleIo().report('  ✗ Claude (default)  NEEDS LOGIN');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe('  ✗ Claude (default)  NEEDS LOGIN');
  });

  it('should construct every adapter with its production default collaborator', () => {
    // Constructing the defaults must be side-effect free off a TTY (nothing starts rendering).
    expect(new OraSpinner()).toBeInstanceOf(OraSpinner);
    expect(new InquirerPrompt()).toBeInstanceOf(InquirerPrompt);
  });

  it('should delegate live status to ora', () => {
    const events: string[] = [];
    const spinner = {
      start: (text: string) => events.push(`start:${text}`),
      succeed: (text: string) => events.push(`succeed:${text}`),
      fail: (text: string) => events.push(`fail:${text}`),
    } as unknown as Ora;
    const subject = new OraSpinner(spinner);

    subject.start('working');
    subject.succeed('done');
    subject.fail('failed');

    expect(events).toEqual(['start:working', 'succeed:done', 'fail:failed']);
  });

  it('should delegate questions to inquirer and return the answer', async () => {
    const client = {
      prompt: async (questions: ReadonlyArray<Record<string, unknown>>) => {
        expect(questions).toEqual([{ type: 'input', name: 'answer', message: 'value?' }]);
        return { answer: 'chosen' };
      },
    } as unknown as Pick<typeof inquirer, 'prompt'>;

    expect(await new InquirerPrompt(client).ask('value?')).toBe('chosen');
  });
});
