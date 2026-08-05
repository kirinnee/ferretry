import { Readable } from 'node:stream';
import { describe, expect, it } from 'bun:test';
import { SecretConsoleOutput } from '../../../src/adapters/secrets/secret-output';
import { StdinSecretValue } from '../../../src/adapters/secrets/stdin-secret-value';

/**
 * The two adapters the secret commands need from the terminal: where a value comes IN, and how a
 * child's output goes back OUT.
 */

function stdin(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

describe('reading a value from stdin', () => {
  it('should read a piped value', async () => {
    expect(await new StdinSecretValue(stdin('sk-live-0123456789')).read()).toBe('sk-live-0123456789');
  });

  it('should strip exactly one trailing newline, so echo and printf agree', async () => {
    // Assert — otherwise half the people using this store a credential with a newline welded on and
    // get a signature failure they cannot see.
    expect(await new StdinSecretValue(stdin('sk-live-0123456789\n')).read()).toBe('sk-live-0123456789');
    expect(await new StdinSecretValue(stdin('sk-live-0123456789\n\n')).read()).toBe('sk-live-0123456789\n');
  });

  it('should keep other whitespace, which can be load-bearing in a key', async () => {
    expect(await new StdinSecretValue(stdin('  padded-secret  ')).read()).toBe('  padded-secret  ');
  });

  it('should refuse an empty stdin with the spelling that works', async () => {
    await expect(new StdinSecretValue(stdin('')).read()).rejects.toThrow(/printf/u);
  });

  it('should read a multi-chunk stream whole', async () => {
    // Arrange — a PEM arrives in pieces.
    const stream = Readable.from([Buffer.from('-----BEGIN'), Buffer.from(' KEY-----\n')]);

    // Act / Assert
    expect(await new StdinSecretValue(stream).read()).toBe('-----BEGIN KEY-----');
  });
});

describe('relaying a child‘s output', () => {
  it('should write each stream through verbatim and leave messages to the console', () => {
    // Arrange
    const written: [string, string][] = [];
    const console_ = { messages: [] as string[], errors: [] as string[], code: undefined as number | undefined };
    const output = new SecretConsoleOutput(
      {
        success: message => console_.messages.push(message),
        error: message => console_.errors.push(message),
        setExitCode: code => {
          console_.code = code;
        },
      },
      { write: text => written.push(['stdout', text]) },
      { write: text => written.push(['stderr', text]) },
    );

    // Act
    output.raw('stdout', '{"ok":true}');
    output.raw('stderr', 'warning\n');
    output.success('stored');
    output.error('failed');
    output.setExitCode(3);

    // Assert — no colour, no appended newline: an agent piping this into `jq` gets what curl wrote.
    expect(written).toEqual([
      ['stdout', '{"ok":true}'],
      ['stderr', 'warning\n'],
    ]);
    expect(console_.messages).toEqual(['stored']);
    expect(console_.errors).toEqual(['failed']);
    expect(console_.code).toBe(3);
  });
});
