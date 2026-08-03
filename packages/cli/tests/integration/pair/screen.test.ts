import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import should from 'should';
import { PlainScreen, ProcessTerminalSize } from '../../../src/adapters/pair/screen';

describe('pairing screen adapters', () => {
  afterEach(() => {
    mock.restore();
  });

  it('should write the screen verbatim, with no colour codes around the QR', () => {
    // Arrange
    const written: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });

    // Act
    new PlainScreen().write('  ▀▄█\n  █▄▀');

    // Assert
    expect(write).toHaveBeenCalledTimes(1);
    should(written).eql(['  ▀▄█\n  █▄▀\n']);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the assertion is that no escape reaches the QR.
    should(written[0]).not.match(/\[/u);
  });

  it('should report the real terminal width when the terminal states one', () => {
    // Arrange
    const original = process.stdout.columns;
    try {
      process.stdout.columns = 132;

      // Act + Assert
      should(new ProcessTerminalSize().columns()).equal(132);
    } finally {
      process.stdout.columns = original;
    }
  });

  it('should report no width rather than a fake one when stdout is not a terminal', () => {
    // A pipe reports 0 or nothing. Reporting it as a width would withhold the QR from every
    // redirected run, which is the opposite of what a capture wants.
    const original = process.stdout.columns;
    try {
      process.stdout.columns = 0;
      should(new ProcessTerminalSize().columns()).be.undefined();

      // @ts-expect-error — a non-TTY stdout genuinely has no `columns`, which the DOM types deny.
      process.stdout.columns = undefined;
      should(new ProcessTerminalSize().columns()).be.undefined();
    } finally {
      process.stdout.columns = original;
    }
  });
});
