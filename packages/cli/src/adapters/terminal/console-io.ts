import { createInterface } from 'node:readline/promises';
import type { TerminalIo } from '@ferretry/kernel/manifest';

/** The terminal port: stdout is a command's answer, stderr is everything else. No colour: scripts and agents read it too. */
export class ConsoleIo implements TerminalIo {
  out(text: string): void {
    process.stdout.write(text);
  }

  err(text: string): void {
    process.stderr.write(text);
  }

  get stdinIsTty(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  get isTty(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /**
   * One question on stderr (stdout stays the command's answer), answered on stdin. Only when stdin AND stdout are a
   * terminal; a script gets none, so a verb that needs an answer refuses instead of waiting. The answer echoes: this
   * is never the way to take a password or a secret.
   */
  get ask(): ((message: string) => Promise<string>) | undefined {
    if (!this.isTty) return undefined;
    return async message => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await terminal.question(`${message} `);
      } finally {
        terminal.close();
      }
    };
  }
}
