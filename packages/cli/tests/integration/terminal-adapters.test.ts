import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type inquirer from 'inquirer';
import type { Ora } from 'ora';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';
import { InquirerPrompt } from '../../src/adapters/terminal/prompt';
import { OraSpinner } from '../../src/adapters/terminal/spinner';

describe('terminal and system adapters', () => {
  afterEach(() => {
    mock.restore();
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

  it('should ask for a password without echoing it, and without disclosing its length', async () => {
    // TWO PROPERTIES, BOTH ASSERTED ON THE QUESTION ITSELF. `type: 'password'` is what suppresses the
    // echo — an `input` question here would print the operator password into the scrollback of whoever
    // was looking at that terminal, and nothing takes it back out. And NO `mask`: a row of asterisks
    // discloses the length to somebody watching the screen, which is the one thing they would otherwise
    // have to guess.
    const questions: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const client = {
      prompt: async (asked: ReadonlyArray<Record<string, unknown>>) => {
        questions.push(asked);
        return { answer: 'correct horse' };
      },
    } as unknown as Pick<typeof inquirer, 'prompt'>;

    expect(await new InquirerPrompt(client).askSecret('Operator password: ')).toBe('correct horse');
    expect(questions).toEqual([[{ type: 'password', name: 'answer', message: 'Operator password: ' }]]);
    expect(questions[0]?.[0]).not.toHaveProperty('mask');
  });
});
