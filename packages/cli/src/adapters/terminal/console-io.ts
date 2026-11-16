import type { TerminalIo } from '@ferretry/kernel/manifest';

/** The terminal port: stdout is a command's answer, stderr is everything else. No colour: scripts and agents read it too. */
export class ConsoleIo implements TerminalIo {
  out(text: string): void {
    process.stdout.write(text);
  }

  err(text: string): void {
    process.stderr.write(text);
  }

  get isTty(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}
