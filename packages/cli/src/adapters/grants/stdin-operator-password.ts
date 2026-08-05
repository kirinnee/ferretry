import type { IOperatorPasswordSource } from '../../lib/grants/ports.ts';

/**
 * Reads the operator password from standard input.
 *
 * THE ONLY WAY IN, for the reason `fy secret set` takes no value argument: a password passed as an
 * argument is in the shell history of whoever typed it and in `/proc/<pid>/cmdline` for every account
 * on the machine while the command runs. There is deliberately no flag that accepts one.
 *
 * IT DOES NOT PROMPT. This has to work under a service manager and inside provisioning scripts, so
 * reading stdin is both the scriptable form and the safe one — a prompt would make the unattended
 * case impossible while making the interactive case no safer.
 *
 * ONE TRAILING NEWLINE IS STRIPPED, and only one, so `printf %s` and `echo` store the same thing.
 * Anything else is kept: whitespace can be deliberate in a password, and silently altering one
 * produces a failure whose cause is invisible.
 */
export class StdinOperatorPassword implements IOperatorPasswordSource {
  constructor(private readonly stream: NodeJS.ReadableStream = process.stdin) {}

  async read(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.stream) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
      throw new Error(
        'no password on stdin — pipe it in, e.g. `printf %s "$FY_OPERATOR_PASSWORD" | fy daemon password set`',
      );
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  }
}
