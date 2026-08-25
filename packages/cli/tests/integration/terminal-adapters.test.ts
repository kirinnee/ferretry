import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import chalk from 'chalk';
import type inquirer from 'inquirer';
import type { Ora } from 'ora';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';
import { chalkFleetPalette, terminalFleetPresentation } from '../../src/adapters/terminal/palette';
import { InquirerPrompt } from '../../src/adapters/terminal/prompt';
import { OraSpinner } from '../../src/adapters/terminal/spinner';
import { FALLBACK_TERMINAL_WIDTH, NARROWEST_USABLE_WIDTH } from '../../src/lib/fleet/presentation';

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
    // report whose colour means something PER LINE: a green wrap over `fy fleet health` gave a
    // rejected account and a healthy one the same paint, so colour carried nothing and every row had
    // to be read to be triaged. The renderer has to be the last thing that paints.
    chalk.level = 1;
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    new ConsoleIo().report('  ✗ Claude (default)  NEEDS LOGIN');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe('  ✗ Claude (default)  NEEDS LOGIN');
  });

  it('should turn each fleet meaning into a distinct colour, and every one back off together', () => {
    // chalk owns `NO_COLOR` and the is-this-a-terminal question, and answers them PER CALL against
    // its own detected level. That is the whole reason it is used instead of hand-rolled escapes: a
    // second implementation of "may I use colour" is how a redirect ends up with control characters
    // in the file it was redirected into.
    chalk.level = 1;
    const painted = chalkFleetPalette();
    const inks = [painted.danger('x'), painted.good('x'), painted.muted('x'), painted.command('x')];

    expect(new Set(inks).size).toBe(4);
    for (const ink of inks) expect(ink).toContain('x');

    chalk.level = 0;
    const plain = chalkFleetPalette();
    expect([plain.danger('x'), plain.good('x'), plain.muted('x'), plain.command('x')]).toEqual(['x', 'x', 'x', 'x']);
  });

  it('should honour a real terminal width, fall back when there is none, and refuse a degenerate one', () => {
    // Nothing and 0 both mean the surface never said: a pipe, a redirect and an unsized pty all report
    // one or the other. Rounding a genuinely narrow window UP to the fallback would hand the wrapping
    // back to the terminal, which indents nothing.
    const surface = { terminal: true, noColor: undefined };
    expect(terminalFleetPresentation({ ...surface, columns: undefined }).width).toBe(FALLBACK_TERMINAL_WIDTH);
    expect(terminalFleetPresentation({ ...surface, columns: 0 }).width).toBe(FALLBACK_TERMINAL_WIDTH);
    expect(terminalFleetPresentation({ ...surface, columns: 140 }).width).toBe(140);
    expect(terminalFleetPresentation({ ...surface, columns: 12 }).width).toBe(NARROWEST_USABLE_WIDTH);
  });

  it('should emit no escape code at all under NO_COLOR, whatever chalk believes', () => {
    // THE REASON THIS DOES NOT DELEGATE TO CHALK: chalk 5 under Bun reports full colour support with
    // NO_COLOR=1 set. Forcing the level up is exactly that situation, and trusting chalk here would
    // put escape codes in the output of somebody who asked, in the documented way, for none.
    chalk.level = 3;
    const surface = { terminal: true, columns: 120 };

    for (const noColor of ['1', 'true', '0']) {
      const { palette } = terminalFleetPresentation({ ...surface, noColor });
      expect([palette.danger('x'), palette.good('x'), palette.muted('x'), palette.command('x')]).toEqual([
        'x',
        'x',
        'x',
        'x',
      ]);
    }

    // An EMPTY value is not a request for no colour — the convention is that the variable is set to
    // something — so this one still paints.
    expect(terminalFleetPresentation({ ...surface, noColor: '' }).palette.danger('x')).not.toBe('x');
  });

  it('should paint nothing when stdout is not a terminal, so a pipe carries no control characters', () => {
    chalk.level = 3;

    const { palette } = terminalFleetPresentation({ terminal: false, columns: 200, noColor: undefined });

    expect([palette.danger('x'), palette.good('x'), palette.muted('x'), palette.command('x')]).toEqual([
      'x',
      'x',
      'x',
      'x',
    ]);
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
