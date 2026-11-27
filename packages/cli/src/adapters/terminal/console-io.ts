import { createInterface } from 'node:readline/promises';
import type { TerminalIo } from '@ferretry/kernel/manifest';

/**
 * One write. A reader that has already gone (`fy --help | head`) is the reader's decision, not a failure of the command, so
 * a broken pipe is dropped: the command carries on to its own exit code and prints no stack. Anything else still throws.
 * The `error` listener covers a write the stream only fails later, which would otherwise be an uncaught exception.
 */
function writeTo(stream: NodeJS.WriteStream, text: string): void {
  if (stream.listenerCount('error') === 0) stream.on('error', ignoreBrokenPipe);
  try {
    stream.write(text);
  } catch (error: unknown) {
    ignoreBrokenPipe(error);
  }
}

function ignoreBrokenPipe(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
}

/** The terminal port: stdout is a command's answer, stderr is everything else. No colour: scripts and agents read it too. */
export class ConsoleIo implements TerminalIo {
  out(text: string): void {
    writeTo(process.stdout, text);
  }

  err(text: string): void {
    writeTo(process.stderr, text);
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
