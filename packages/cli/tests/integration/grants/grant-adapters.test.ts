import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { StdinOperatorPassword } from '../../../src/adapters/grants/stdin-operator-password';

/**
 * Where the operator password comes IN.
 *
 * Stdin is the only way, for the reason `fy secret set` takes no value argument: a password passed
 * as an argument is in the shell history of whoever typed it and in `/proc/<pid>/cmdline` for every
 * account on the machine while the command runs. It is also the form that works unattended, which a
 * prompt would not be.
 */

function stdin(text: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

describe('reading the operator password from stdin', () => {
  it('should read a piped password', async () => {
    expect(await new StdinOperatorPassword(stdin('correct horse battery')).read()).toBe('correct horse battery');
  });

  it('should strip exactly one trailing newline, so echo and printf agree', async () => {
    // Otherwise half the people setting this store a password with a newline welded on and cannot
    // work out why the one they type afterwards is refused.
    expect(await new StdinOperatorPassword(stdin('operator-secret\n')).read()).toBe('operator-secret');
    expect(await new StdinOperatorPassword(stdin('operator-secret\n\n')).read()).toBe('operator-secret\n');
  });

  it('should keep other whitespace, which can be deliberate in a password', async () => {
    expect(await new StdinOperatorPassword(stdin('  spaced out  ')).read()).toBe('  spaced out  ');
  });

  it('should refuse an empty stdin with the spelling that actually works', async () => {
    await expect(new StdinOperatorPassword(stdin('')).read()).rejects.toThrow(/fy daemon password set/u);
  });

  it('should read a multi-chunk stream whole', async () => {
    // Arrange — a long passphrase arrives in pieces.
    const stream = Readable.from([Buffer.from('a very long '), Buffer.from('operator passphrase')]);

    // Act + Assert
    expect(await new StdinOperatorPassword(stream).read()).toBe('a very long operator passphrase');
  });
});
