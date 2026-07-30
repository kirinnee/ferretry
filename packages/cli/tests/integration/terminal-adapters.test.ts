import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { SingleBar } from 'cli-progress';
import type inquirer from 'inquirer';
import type { Ora } from 'ora';
import { BunShell } from '../../src/adapters/system/shell';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';
import { CliProgressBar } from '../../src/adapters/terminal/progress';
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
    subject.setExitCode(7);

    expect(log).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(7);
    expect(typeof subject.interactive()).toBe('boolean');
  });

  it('should construct every adapter with its production default collaborator', () => {
    // Constructing the defaults must be side-effect free off a TTY (nothing starts rendering).
    expect(new OraSpinner()).toBeInstanceOf(OraSpinner);
    expect(new CliProgressBar()).toBeInstanceOf(CliProgressBar);
    expect(new InquirerPrompt()).toBeInstanceOf(InquirerPrompt);
  });

  it('should delegate progress state to cli-progress', () => {
    const events: string[] = [];
    const bar = {
      start: (total: number, current: number) => events.push(`start:${total}:${current}`),
      increment: () => events.push('tick'),
      stop: () => events.push('stop'),
    } as unknown as SingleBar;
    const subject = new CliProgressBar(bar);

    subject.start(3);
    subject.tick();
    subject.stop();

    expect(events).toEqual(['start:3:0', 'tick', 'stop']);
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

  it('should report the host platform through BunShell', async () => {
    expect(await new BunShell().platform()).toMatch(/\S+/);
  });
});
