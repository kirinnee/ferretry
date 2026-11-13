import type { SecretValueSource } from './secret-controller.ts';

/**
 * Reads a secret value: typed at a terminal WITHOUT ECHO, or piped on standard input. Never an argument.
 *
 * ON A TERMINAL the shell's `promptHidden` asks `value for NAME (hidden; press Enter when done): ` on stderr, turns the
 * terminal's echo off, reads ONE line and puts the terminal back (also on Ctrl-C, which ends the command with 130). The
 * value is never on the screen or in its scrollback, and nothing here writes it anywhere. An empty line is refused:
 * nothing is stored.
 *
 * PIPED (no terminal: `promptHidden` answers `undefined`, or the shell offers none) is today's behaviour exactly: the
 * shell's `readText('-')` reads standard input to its end.
 *
 * ONE TRAILING NEWLINE IS STRIPPED from piped text, and only one. `printf %s "$KEY" | fy secret set NAME` and
 * `echo "$KEY" | fy secret set NAME` must store the same thing. Any other whitespace is kept: it can be load-bearing in a
 * key, and silently altering a credential produces a failure whose cause is invisible.
 *
 * THE ONLY WAYS IN. A value passed as an argument would be in the shell history of whoever typed it and in
 * `/proc/<pid>/cmdline` for every account on the machine while the command runs, so no argument accepts one.
 */
export class StdinSecretValue implements SecretValueSource {
  constructor(
    private readonly binaryName: string,
    private readonly readText: ((path: string) => Promise<string>) | undefined,
    private readonly promptHidden: ((question: string) => Promise<string | undefined>) | undefined = undefined,
  ) {}

  async read(name: string): Promise<string> {
    if (this.promptHidden !== undefined) {
      const typed = await this.promptHidden(`value for ${name} (hidden; press Enter when done): `);
      if (typed !== undefined) {
        if (typed === '') throw new Error('no value typed — nothing was stored');
        return typed;
      }
    }
    if (this.readText === undefined) throw new Error('this fy shell cannot read standard input yet; update fy');
    const text = await this.readText('-');
    if (text === '')
      throw new Error(
        `no value on stdin — pipe the secret in, e.g. \`printf %s "$KEY" | ${this.binaryName} secret set NAME\``,
      );
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
}
