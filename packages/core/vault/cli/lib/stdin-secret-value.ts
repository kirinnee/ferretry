import type { SecretValueSource } from './secret-controller.ts';

/**
 * Reads a secret value from standard input, through the shell's `readText('-')`.
 *
 * THE ONLY WAY IN. A value passed as an argument would be in the shell history of whoever typed it and in
 * `/proc/<pid>/cmdline` for every account on the machine while the command runs, so no argument accepts one.
 *
 * ONE TRAILING NEWLINE IS STRIPPED, and only one. `printf %s "$KEY" | fy secret set NAME` and
 * `echo "$KEY" | fy secret set NAME` must store the same thing. Any other whitespace is kept: it can be load-bearing in a
 * key, and silently altering a credential produces a failure whose cause is invisible.
 */
export class StdinSecretValue implements SecretValueSource {
  constructor(
    private readonly binaryName: string,
    private readonly readText: ((path: string) => Promise<string>) | undefined,
  ) {}

  async read(): Promise<string> {
    if (this.readText === undefined) throw new Error('this fy shell cannot read standard input yet; update fy');
    const text = await this.readText('-');
    if (text === '')
      throw new Error(
        `no value on stdin — pipe the secret in, e.g. \`printf %s "$KEY" | ${this.binaryName} secret set NAME\``,
      );
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
}
