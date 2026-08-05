import type { ISecretValueSource } from '../../lib/secrets/ports.ts';

/**
 * Reads a secret value from standard input.
 *
 * THE ONLY WAY IN. A value passed as an argument would be in the shell history of whoever typed it
 * and in `/proc/<pid>/cmdline` for every account on the machine while the command runs, which is the
 * exact disclosure the store exists to prevent. So there is no argument that accepts one.
 *
 * ONE TRAILING NEWLINE IS STRIPPED, and only one. `printf %s "$KEY" | fy secret set NAME` and
 * `echo "$KEY" | fy secret set NAME` must store the same thing, or half the people using this store
 * a credential with a newline welded to the end and get a signature failure they cannot see. Any
 * other whitespace is kept: it can be load-bearing in a key, and silently altering a credential
 * produces a failure whose cause is invisible.
 */
export class StdinSecretValue implements ISecretValueSource {
  constructor(private readonly stream: NodeJS.ReadableStream = process.stdin) {}

  async read(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
      throw new Error('no value on stdin — pipe the secret in, e.g. `printf %s "$KEY" | fy secret set NAME`');
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
}
